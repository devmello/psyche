-- S01 (VM mode, L1–L5): where a Task's commands run. `sandbox` is the per-task container on
-- the Gateway host, `vm` the sandbox Mac guest through its psyche-node. NULL means the owner's
-- default at run time (`vm.defaultWorkspace`, else sandbox).
ALTER TABLE tasks ADD COLUMN workspace TEXT CHECK (workspace IS NULL OR workspace IN ('sandbox', 'vm'));
