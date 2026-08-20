--!strict
--[[
	The check the Lune harness cannot make: this runs inside Roblox.

	The harness reimplements Roblox's require semantics, so it proves the tree is
	consistent under a model of the engine. This proves it under the engine. The
	difference only matters if that model is wrong somewhere — which is exactly the
	risk a reimplementation carries, so the two are worth keeping separate.

	Run with `rojo serve` from test/roblox, then press Play.
]]

local Packages = game:GetService("ReplicatedStorage"):WaitForChild("RARN_MODULE")

local passed, failed = 0, 0

local function check(label: string, ok: boolean, detail: string?)
	if ok then
		passed += 1
		print(`  ok    {label}`)
	else
		failed += 1
		warn(`  FAIL  {label}{if detail then " — " .. detail else ""}`)
	end
end

print("\nverifying the Rarn install inside Roblox\n")

-- 1. The names a person actually writes.
local Knit = require(Packages.Knit)
check("require(RARN_MODULE.Knit)", Knit ~= nil)

local Promise = require(Packages.Promise)
check("require(RARN_MODULE.Promise)", Promise ~= nil)

-- 2. Deduplication. Three paths reach evaera/promise: directly, through Knit's
--    entry, and through Comm's. All three must be the same table, or every
--    singleton inside Promise silently becomes three.
local index = Packages._Index
local viaKnit = require(index["sleitnick_knit@1.7.0"].Promise)
local viaComm = require(index["sleitnick_comm@1.0.1"].Promise)

check("Promise via Knit is the same table", rawequal(Promise, viaKnit), "two copies exist")
check("Promise via Comm is the same table", rawequal(Promise, viaComm), "two copies exist")

-- 3. The package actually works, which is the part no emulator can answer.
local resolved = false
Promise.new(function(resolveFn)
	resolveFn(42)
end):andThen(function(value)
	resolved = value == 42
end)
task.wait()
check("Promise resolves a value", resolved)

check("Knit exposes Util as a folder", typeof(Knit.Util) == "Instance")

print(`\n{passed}/{passed + failed} checks passed inside Roblox`)
if failed > 0 then
	error(`{failed} checks failed`, 0)
end
