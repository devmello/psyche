-- The device family a node or client declared when it paired (remote Gateway R0): "mac-helper",
-- "desktop", "vm-guest", "psyche-node", ... The Gateway pins it at pairing and refuses a paired
-- device that later connects declaring another family, so a device cannot turn itself into a Mac
-- helper by changing what it says. NULL for devices paired before this column existed: the first
-- connect after the upgrade records the family it declares.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

ALTER TABLE devices ADD COLUMN device_family TEXT;
