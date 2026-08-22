--!strict
--[[
	Checks the emulator itself, rather than an install tree.

	    lune run tests/roblox/emulate-selftest.luau -- <scratch-dir>

	`verify.luau` asks whether a tree Rarn built is correct *under this model*. Nothing
	asked whether the model behaves the way it claims to, and two defects lived in that
	gap: the instance proxy had no `:WaitForChild`, which is how the entire JS-port half
	of the registry navigates, and a module that failed once was reported as a cyclic
	require ever after.

	Both are the same kind of mistake — the harness answering confidently about
	something it had not implemented — which is the kind this file exists to catch.

	The fixture is written here rather than handed in, so the tree and the assertions
	about it stay in one place.
]]

local fs = require("@lune/fs")
local process = require("@lune/process")
local Emulator = require("./emulate")

local args = {}
for _, value in process.args do
	if value ~= "--" then
		table.insert(args, value)
	end
end

local scratch = args[1]
if scratch == nil then
	print("usage: lune run tests/roblox/emulate-selftest.luau -- <scratch-dir>")
	process.exit(2)
end

local failures = 0
local checks = 0

local function check(label: string, ok: boolean, detail: string?)
	checks += 1
	if ok then
		print(`  ok    {label}`)
	else
		failures += 1
		print(`  FAIL  {label}{if detail then "\n          " .. detail else ""}`)
	end
end

-- The fixture. `Root` is a ModuleScript folder holding a Folder and two modules, which
-- is the shape every `_Index` entry has.
local tree = `{scratch}/tree`
fs.writeDir(`{tree}/Root/Nested`)
fs.writeFile(`{tree}/Root/init.luau`, "return { name = 'root' }")
fs.writeFile(`{tree}/Root/Leaf.luau`, "return { name = 'leaf' }")
fs.writeFile(`{tree}/Root/Nested/Deep.luau`, "return { name = 'deep' }")
-- A child named after a method, to pin down which one wins.
fs.writeFile(`{tree}/Root/GetChildren.luau`, "return { name = 'decoy' }")
fs.writeFile(`{tree}/Boom.luau`, "error('boom')")
fs.writeFile(`{tree}/CycleA.luau`, "return require(script.Parent.CycleB)")
fs.writeFile(`{tree}/CycleB.luau`, "return require(script.Parent.CycleA)")
-- What a real package's module scope does: reach into the engine and keep going.
fs.writeFile(
	`{tree}/TouchesEngine.luau`,
	"local rs = game:GetService('RunService')\n"
		.. "rs.Heartbeat:Connect(function() end)\n"
		.. "return { connected = true }"
)

local root = Emulator.tree(tree, "R")
local rt = Emulator.runtime(root, { execute = true })
local Root = rt.root.Root

print("\nemulator selftest\n")

-- 1. The lookups package code actually uses. Same operation as indexing, and that
--    equivalence is the thing to assert: a different answer here would be a model
--    that quietly disagrees with itself.
check("WaitForChild finds a child", Root:WaitForChild("Leaf") ~= nil)
check("FindFirstChild finds a child", Root:FindFirstChild("Leaf") ~= nil)
check("WaitForChild == indexing, same instance", rawequal(Root:WaitForChild("Leaf"), Root.Leaf))
check("a missing child is nil, not an error", Root:FindFirstChild("Nope") == nil)
check("WaitForChild does not block on a missing child", Root:WaitForChild("Nope") == nil)
check(
	"FindFirstChild(name, true) recurses",
	rawequal(Root:FindFirstChild("Deep", true), Root.Nested.Deep)
)
check("FindFirstChildOfClass picks by ClassName", Root:FindFirstChildOfClass("Folder") ~= nil)
check("FindFirstAncestor walks up", rawequal(Root.Nested.Deep:FindFirstAncestor("R"), rt.root))

-- 2. Class hierarchy. Short, but complete for what this harness can hold.
check("a ModuleScript IsA ModuleScript", Root:IsA("ModuleScript"))
check("a ModuleScript IsA LuaSourceContainer", Root:IsA("LuaSourceContainer"))
check("a ModuleScript IsA Instance", Root:IsA("Instance"))
check("a Folder IsA Instance", Root.Nested:IsA("Instance"))
check("a Folder is not a ModuleScript", not Root.Nested:IsA("ModuleScript"))

-- 3. Listing. Roblox returns insertion order and a tree read off a filesystem has none
--    to recover, so this is sorted — knowingly different from the engine, and the same
--    on every run.
local children = Root:GetChildren()
check("GetChildren returns every child", #children == 3, `got {#children}`)
check(
	"GetChildren is sorted, so a run repeats",
	tostring(children[1]) == "GetChildren" and tostring(children[2]) == "Leaf"
)
check("GetChildren yields the same instances as indexing", rawequal(children[2], Root.Leaf))
check("GetDescendants reaches through folders", #Root:GetDescendants() == 4)
check("IsDescendantOf answers down the chain", Root.Nested.Deep:IsDescendantOf(rt.root))
check("IsAncestorOf is its inverse", rt.root:IsAncestorOf(Root.Nested.Deep))
check("GetFullName names the path it was given", Root.Leaf:GetFullName() == "R.Root.Leaf")

-- 4. A member wins over a child of the same name, as Roblox resolves it. Worth pinning:
--    the decoy is reachable, just not by the name the method occupies.
check("a method beats a child with its name", type(Root.GetChildren) == "function")
check("that child is still reachable", Root:FindFirstChild("GetChildren") ~= nil)

-- 5. Nothing that mutates the tree, on purpose. The identity guarantee this harness
--    exists to check cannot be left to the code being checked.
check("Destroy is not offered", Root.Destroy == nil)
check("Clone is not offered", Root.Clone == nil)

-- 6. A failed require must keep reporting why it failed.
local _, first = pcall(rt.require, rt.root.Boom)
local _, second = pcall(rt.require, rt.root.Boom)
check(
	"a module that failed once reports the same reason twice",
	string.find(tostring(second), "boom", 1, true) ~= nil,
	`second attempt said: {tostring(second)}`
)
check("...and not a cycle that is not there", string.find(tostring(second), "cyclic", 1, true) == nil)
check("the first attempt did report the real error", string.find(tostring(first), "boom", 1, true) ~= nil)

-- 7. A real cycle is still a cycle.
local _, cyclic = pcall(rt.require, rt.root.CycleA)
check(
	"a genuine cycle is still detected",
	string.find(tostring(cyclic), "cyclic require", 1, true) ~= nil,
	tostring(cyclic)
)

-- 8. The `game` stub is permissive in the way its own comment always claimed. It has
--    to be exercised from inside a module, since that is the only place `game` exists.
local touched, service = pcall(rt.require, rt.root.TouchesEngine)
check("game:GetService can be called at module scope", touched, tostring(service))
check(
	"and the result keeps answering",
	touched and (service :: any).connected == true,
	"a stub that stops one level down is the hard error it was meant to avoid"
)

print(`\n{checks - failures}/{checks} checks passed`)

if failures > 0 then
	process.exit(1)
end
