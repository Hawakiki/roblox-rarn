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
for _, value in process.args do
	if value == "--execute" then
		execute = true
	elseif value ~= "--" then
		table.insert(args, value)
	end
end

local installDir = args[1]
local realmName = args[2] or "RARN_MODULE"

if installDir == nil then
	print("usage: lune run tests/roblox/verify.luau -- <install-dir> [<realm-name>] [--execute]")
	process.exit(2)
end

local failures: { string } = {}
local checks = 0

local function check(label: string, ok: boolean, detail: string?)
	checks += 1
	if ok then
		print(`  ok    {label}`)
	else
		print(`  FAIL  {label}{if detail then "\n          " .. detail else ""}`)
		table.insert(failures, label)
	end
end

local root = Emulator.tree(installDir, realmName)
local runtime = Emulator.runtime(root, {
	execute = execute,
	globals = {
		-- Only reached with --execute, and deliberately thin: a stub rich enough to
		-- run real packages would be a reimplementation of the engine, and passing
		-- against it would say nothing about passing in Roblox.
		game = setmetatable({}, {
			__index = function(_, key)
				return { Name = key }
			end,
		}),
		task = { wait = function() end, spawn = function() end, defer = function() end },
		warn = print,
	},
})

print(`\nverifying {installDir}{if execute then " (executing package code)" else ""}\n`)

local indexNode = root.Children._Index
check("_Index exists", indexNode ~= nil)
if indexNode == nil then
	process.exit(1)
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
for entryName, entry in indexNode.Children do
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
for entryName, entry in indexNode.Children do
	for shimName, shim in entry.Children do
		if not Emulator.isShim(shim) then
			continue
		end

		local ok, resolved = pcall(function()
			return runtime.require(runtime.root._Index[entryName][shimName])
		end)
		check(
			`_Index["{entryName}"].{shimName} resolves`,
			ok,
			if ok then nil else tostring(resolved)
		)

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

if #failures > 0 then
	print("\nfailed:")
	for _, label in failures do
		print(`  - {label}`)
	end
	process.exit(1)
end

print("")
