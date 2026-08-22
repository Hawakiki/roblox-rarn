--!strict
--[[
	Checks a Rarn install tree by resolving it the way Roblox would.

	    lune run tests/roblox/verify.luau -- <install-dir> [<realm-name>] [--execute]

	Exits non-zero with a report on the first failure. A passing run still prints one
	line per check, so it is visible what was actually verified rather than only that
	something was.

	The checks, ordered by how badly each failure bites:

	  1. every top-level shim reaches a real ModuleScript
	  2. every `_Index` entry exposes its package as a module, not a bare folder
	  3. **one package reached by two paths is one instance**

	Three cannot be caught by comparing file trees. Two copies of a package look
	perfectly fine on disk and diverge only at runtime, when each gets its own state
	and every singleton inside quietly becomes two.

	Package code is not executed by default; see `execute` in emulate.luau for why.
]]

local process = require("@lune/process")
local Emulator = require("./emulate")

-- Lune forwards the `--` separator itself, so it has to be skipped rather than
-- assumed away; invocations with and without it must behave the same.
local args, execute = {}, false
local mountSpecs: { { path: string, dir: string } } = {}

for _, value in process.args do
	if value == "--execute" then
		execute = true
	elseif string.sub(value, 1, 8) == "--mount=" then
		-- `--mount=game.ReplicatedStorage.RARN_MODULE=../RARN_MODULE`
		-- The first `=` after the flag separates it; the DataModel path may not
		-- contain one, so splitting on the first is unambiguous.
		local spec = string.sub(value, 9)
		local at = string.find(spec, "=", 1, true)
		if at == nil then
			print(`bad --mount (expected <DataModelPath>=<dir>): {spec}`)
			process.exit(2)
		end
		table.insert(mountSpecs, {
			path = string.sub(spec, 1, at - 1),
			dir = string.sub(spec, at + 1),
		})
	elseif value ~= "--" then
		table.insert(args, value)
	end
end

local installDir = args[1]
local realmName = args[2] or "RARN_MODULE"

if installDir == nil then
	print(
		"usage: lune run tests/roblox/verify.luau -- <install-dir> [<realm-name>]"
			.. " [--mount=<DataModelPath>=<dir>]... [--execute]"
	)
	process.exit(2)
end

local failures: { string } = {}
local unverified: { string } = {}
local checks = 0

-- 아래 헬퍼들이 닫아 잡으므로 여기서 선언한다. 나중에 선언하면 Luau 가
-- 전역으로 읽어 조용히 nil 이 된다.
local mountedPaths: { string } = {}

local function check(label: string, ok: boolean, detail: string?)
	checks += 1
	if ok then
		print(`  ok    {label}`)
	else
		print(`  FAIL  {label}{if detail then "\n          " .. detail else ""}`)
		table.insert(failures, label)
	end
end

--[[
	Records a check that could not be made, rather than making it and failing.

	A cross-realm shim names an absolute DataModel path. Without a `--mount` for that
	path there is nothing to resolve against, and running the check anyway produces a
	failure that describes the harness rather than the install — which is exactly what
	this harness did until 2026-08-22, reporting a correct shim as broken.

	Counted separately and printed at the end, because the alternative to a false
	failure is not a silent pass.
]]
local function skip(label: string, why: string)
	print(`  skip  {label}\n          {why}`)
	table.insert(unverified, `{label} — {why}`)
end

-- The DataModel path a cross-realm shim reaches for, if it is one.
local function crossRealmTarget(source: string?): string?
	if source == nil then
		return nil
	end
	return string.match(source, "require%s*%(%s*(game[%w_.]*)")
end

local function isMounted(target: string): boolean
	for _, path in mountedPaths do
		if string.sub(target, 1, #path) == path then
			return true
		end
	end
	return false
end

local root = Emulator.tree(installDir, realmName)

-- Mounted realms come from `--mount`. `game` itself is built by the runtime, which
-- owns proxy identity — a mounted tree has to wrap through the same table as the
-- primary one or the dedupe assertion silently changes meaning.
local mounts: { [string]: Emulator.Node } = {}
for _, spec in mountSpecs do
	local leaf = string.match(spec.path, "[^.]+$") or spec.path
	mounts[spec.path] = Emulator.tree(spec.dir, leaf)
	table.insert(mountedPaths, spec.path)
end

local runtime = Emulator.runtime(root, {
	execute = execute,
	mounts = mounts,
	globals = {
		-- Deliberately thin, and reached only with --execute: a stub rich enough to
		-- run real packages would be a reimplementation of the engine, and passing
		-- against it would say nothing about passing in Roblox. `game` is not here
		-- because shims run on *every* invocation, so it is the runtime's job.
		task = { wait = function() end, spawn = function() end, defer = function() end },
		warn = print,
	},
})

print(`\nverifying {installDir}{if execute then " (executing package code)" else ""}\n`)

-- A realm directory with no `_Index` is not broken; it holds nothing but cross-realm
-- shims. Placement resolves to the widest requester, so a package declared under
-- `serverDependencies` that a shared package also needs ends up stored in the shared
-- realm, and the server directory keeps only the shim that points across at it.
--
-- This used to exit 1 on that, which meant the harness reported a correct install as
-- broken — the same shape of mistake as reporting an unmounted cross-realm shim as a
-- failure. Nothing to check here is not the same as a failed check.
local indexNode = root.Children._Index
if indexNode == nil then
	local shims = 0
	for _, node in root.Children do
		if node.ClassName == "ModuleScript" then
			shims += 1
		end
	end
	if shims == 0 then
		check("_Index exists, or the realm holds cross-realm shims", false)
		process.exit(1)
	end
	print(`  note  no _Index — this realm holds {shims} cross-realm shim(s) and nothing else`)
end

-- 1. Top-level shims: the names a person writes in their own code. A failure here
--    means the install is unusable no matter what else is right.
local topLevel: { [string]: any } = {}
for name, node in root.Children do
	if name == "_Index" or node.ClassName ~= "ModuleScript" then
		continue
	end
	local ok, result = pcall(runtime.require, runtime.root[name])
	check(`require({realmName}.{name})`, ok, if ok then nil else tostring(result))
	if ok then
		topLevel[name] = result
	end
end

-- 2. Every `_Index` entry must expose its package as a ModuleScript. A pruning
--    mistake shows up here as a folder: the files are present, one level too deep.
--
--    Empty when the realm has no `_Index` at all, which is a realm holding nothing
--    but cross-realm shims. The loops below then have nothing to walk, which is the
--    correct amount of walking.
local indexEntries = if indexNode == nil then {} else indexNode.Children

for entryName, entry in indexEntries do
	local moduleCount = 0
	for _, child in entry.Children do
		if child.ClassName == "ModuleScript" and not Emulator.isShim(child) then
			moduleCount += 1
		end
	end
	check(
		`_Index["{entryName}"] holds a module`,
		moduleCount > 0,
		"no package module here — pruning may have left it nested one level down"
	)
end

-- 3. Deduplication. Reaching one package from two directions must give one instance.
for entryName, entry in indexEntries do
	for shimName, shim in entry.Children do
		if not Emulator.isShim(shim) then
			continue
		end

		local label = `_Index["{entryName}"].{shimName} resolves`
		local target = crossRealmTarget(shim.Source)
		if target ~= nil and not isMounted(target) then
			-- Two different situations, and the difference is worth printing. Nothing
			-- mounted means the caller did not ask for this check. Something mounted
			-- but not this means the shim and the mounts disagree about where the
			-- realm lives — which is the shape a wrong `place` takes.
			if #mountedPaths == 0 then
				skip(label, `cross-realm shim points at {target}; pass --mount=<path>=<dir> to check it`)
			else
				skip(
					label,
					`shim points at {target}, but the mounted paths are {table.concat(mountedPaths, ", ")}`
				)
			end
			continue
		end

		local ok, resolved = pcall(function()
			return runtime.require(runtime.root._Index[entryName][shimName])
		end)
		check(label, ok, if ok then nil else tostring(resolved))

		local direct = topLevel[shimName]
		if ok and direct ~= nil then
			check(
				`{shimName}: {realmName}.{shimName} == _Index["{entryName}"].{shimName}`,
				rawequal(direct, resolved),
				"two copies resolved — singletons inside this package would break at runtime"
			)
		end
	end
end

print(`\n{checks - #failures}/{checks} checks passed, {runtime.loads()} chunks executed`)

-- Printed even on success. A harness that quietly did not check something reads
-- exactly like one that checked it and passed.
if #unverified > 0 then
	print(`\n{#unverified} not verified:`)
	for _, line in unverified do
		print(`  - {line}`)
	end
end

if #failures > 0 then
	print("\nfailed:")
	for _, label in failures do
		print(`  - {label}`)
	end
	process.exit(1)
end

print("")
