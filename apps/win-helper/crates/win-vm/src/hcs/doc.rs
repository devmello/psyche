//! HCS JSON documents (schema 2, `hcsshim` `internal/hcs/schema2`), generated as plain JSON so
//! every field is visible and unit-tested.
//!
//! The compute system (`HcsCreateComputeSystem`):
//!
//! ```json
//! { "Owner": "psyche-vm-<sid hash>", "SchemaVersion": {"Major": 2, "Minor": 5},
//!   "ShouldTerminateOnLastHandleClosed": true,
//!   "VirtualMachine": {
//!     "StopOnReset": true,
//!     "Chipset": {"LinuxKernelDirect": {"KernelFilePath", "InitRdPath", "KernelCmdLine"}},
//!     "ComputeTopology": {"Memory": {"SizeInMB", "AllowOvercommit": true}, "Processor": {"Count"}},
//!     "Devices": {
//!       "Scsi": {"0": {"Attachments": {"0": {"Type": "VirtualDisk", "Path": system.vhdx},
//!                                      "1": {"Type": "VirtualDisk", "Path": sessiondata.vhdx}}}},
//!       "HvSocket": {"HvSocketConfig": {"DefaultBindSecurityDescriptor": "D:P(A;;FA;;;SY)",
//!                    "DefaultConnectSecurityDescriptor": "D:P(A;;FA;;;SY)", "ServiceTable": {…}}},
//!       "Plan9": {"Shares": [{"Name", "AccessName", "Path", "Port": 564, "Flags"}]},
//!       "ComPorts": {"0": {"NamedPipe": "\\\\.\\pipe\\psyche-vm-console-…"}},
//!       "NetworkAdapters": {"<endpoint>": {"EndpointId", "MacAddress"}}   (NAT opt-in only)
//!     },
//!     "RestoreState": {"SaveStateFilePath"}                                (warm start only)
//! } }
//! ```
//!
//! Only LocalSystem may bind or connect Hyper-V sockets for the guest (the security descriptors),
//! so no other host process can pose as the Gateway endpoint or reach the guest agent.

use serde_json::{Map, Value, json};

/// `D:P(A;;FA;;;SY)`: LocalSystem only.
pub const SYSTEM_ONLY_SD: &str = "D:P(A;;FA;;;SY)";

/// Plan9 share flags (`hcsshim` `plan9`): read-only.
pub const PLAN9_FLAG_READ_ONLY: u32 = 0x0000_0001;

/// The Hyper-V socket service id for a Linux vsock port: `<port as 8 hex>-facb-11e6-bd58-64006a7986d3`.
pub fn vsock_service_id(port: u32) -> String {
    format!("{port:08x}-facb-11e6-bd58-64006a7986d3")
}

#[derive(Debug, Clone, PartialEq)]
pub struct Plan9Share {
    pub name: String,
    pub path: String,
    pub read_only: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Disk {
    pub path: String,
    pub read_only: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VmDoc {
    pub owner: String,
    pub schema: (u32, u32),
    pub kernel: String,
    pub initrd: String,
    pub cmdline: String,
    pub cpus: u32,
    pub memory_mb: u64,
    pub disks: Vec<Disk>,
    pub shares: Vec<Plan9Share>,
    pub plan9_port: u32,
    /// vsock ports the guest uses (Gateway node, guest agent).
    pub vsock_ports: Vec<u32>,
    pub console_pipe: Option<String>,
    /// HNS endpoint id and MAC (`00-15-5D-…`), when NAT is on.
    pub network: Option<(String, String)>,
    pub restore_from: Option<String>,
}

pub fn plan9_share(s: &Plan9Share, port: u32) -> Value {
    json!({
        "Name": s.name,
        "AccessName": s.name,
        "Path": s.path,
        "Port": port,
        "Flags": if s.read_only { PLAN9_FLAG_READ_ONLY } else { 0 },
    })
}

impl VmDoc {
    pub fn to_json(&self) -> Value {
        let mut attachments = Map::new();
        for (i, d) in self.disks.iter().enumerate() {
            attachments.insert(i.to_string(), json!({"Type": "VirtualDisk", "Path": d.path, "ReadOnly": d.read_only}));
        }
        let mut services = Map::new();
        for p in &self.vsock_ports {
            services.insert(
                vsock_service_id(*p),
                json!({"BindSecurityDescriptor": SYSTEM_ONLY_SD, "ConnectSecurityDescriptor": SYSTEM_ONLY_SD, "AllowWildcardBinds": false}),
            );
        }
        let mut devices = json!({
            "Scsi": {"0": {"Attachments": attachments}},
            "HvSocket": {"HvSocketConfig": {
                "DefaultBindSecurityDescriptor": SYSTEM_ONLY_SD,
                "DefaultConnectSecurityDescriptor": SYSTEM_ONLY_SD,
                "ServiceTable": services,
            }},
            "Plan9": {"Shares": self.shares.iter().map(|s| plan9_share(s, self.plan9_port)).collect::<Vec<_>>()},
        });
        if let Some(pipe) = &self.console_pipe {
            devices["ComPorts"] = json!({"0": {"NamedPipe": pipe}});
        }
        if let Some((endpoint, mac)) = &self.network {
            devices["NetworkAdapters"] = json!({ endpoint.clone(): {"EndpointId": endpoint, "MacAddress": hcs_mac(mac)} });
        }
        let mut vm = json!({
            "StopOnReset": true,
            "Chipset": {"LinuxKernelDirect": {"KernelFilePath": self.kernel, "InitRdPath": self.initrd, "KernelCmdLine": self.cmdline}},
            "ComputeTopology": {
                "Memory": {"SizeInMB": self.memory_mb, "AllowOvercommit": true},
                "Processor": {"Count": self.cpus},
            },
            "Devices": devices,
        });
        if let Some(saved) = &self.restore_from {
            vm["RestoreState"] = json!({"SaveStateFilePath": saved});
        }
        json!({
            "Owner": self.owner,
            "SchemaVersion": {"Major": self.schema.0, "Minor": self.schema.1},
            "ShouldTerminateOnLastHandleClosed": true,
            "VirtualMachine": vm,
        })
    }
}

/// `00:15:5d:aa:bb:cc` → `00-15-5D-AA-BB-CC` (HCS form).
pub fn hcs_mac(mac: &str) -> String {
    mac.replace(':', "-").to_ascii_uppercase()
}

/// `HcsModifyComputeSystem`: hot-add a Plan9 share.
pub fn add_share_request(s: &Plan9Share, port: u32) -> Value {
    json!({"ResourcePath": "VirtualMachine/Devices/Plan9/Shares", "RequestType": "Add", "Settings": plan9_share(s, port)})
}

/// `HcsModifyComputeSystem`: remove a Plan9 share.
pub fn remove_share_request(name: &str, port: u32) -> Value {
    json!({"ResourcePath": "VirtualMachine/Devices/Plan9/Shares", "RequestType": "Remove", "Settings": {"Name": name, "AccessName": name, "Port": port}})
}

/// `HcsSaveComputeSystem` options.
pub fn save_options(path: &str) -> Value {
    json!({"SaveType": "ToFile", "SaveStateFilePath": path})
}

/// `HcsShutDownComputeSystem` options (schema 2.5+): the Hyper-V shutdown integration service
/// (`hv_utils` in the guest kernel runs `poweroff`).
pub fn shutdown_options() -> Value {
    json!({"Mechanism": "IntegrationService", "Type": "Shutdown", "Force": false, "Reason": "Psyche sandbox PC stop"})
}

/// The kernel command line: the image's base line plus the Psyche parameters the guest reads.
pub fn kernel_cmdline(base: Option<&str>, name: &str, gateway_port: u32, agent_port: u32, plan9_port: u32, first_boot: bool) -> String {
    let base = base.unwrap_or("console=ttyS0 quiet panic=-1");
    let mut s = format!(
        "{base} psyche.vm={name} psyche.gateway_port={gateway_port} psyche.agent_port={agent_port} psyche.plan9_port={plan9_port} psyche.meta={}",
        crate::shares::SHARE_META
    );
    if first_boot {
        s.push_str(" psyche.provision=1");
    }
    s
}

/// Highest schema version the service supports, capped at 2.5 (`HcsGetServiceProperties`
/// `{"PropertyTypes": ["Basic"]}` → `SupportedSchemaVersions`). LinuxKernelDirect needs 2.2.
pub fn pick_schema(service_properties: &Value) -> Option<(u32, u32)> {
    let list = service_properties["Properties"].as_array().and_then(|a| a.first()).unwrap_or(service_properties);
    let versions = list["SupportedSchemaVersions"].as_array()?;
    versions
        .iter()
        .filter_map(|v| Some((v["Major"].as_u64()? as u32, v["Minor"].as_u64()? as u32)))
        .filter(|v| *v <= (2, 5) && *v >= (2, 2))
        .max()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc() -> VmDoc {
        VmDoc {
            owner: "psyche-vm-abc".into(),
            schema: (2, 5),
            kernel: r"C:\img\vmlinuz".into(),
            initrd: r"C:\img\initrd".into(),
            cmdline: kernel_cmdline(None, "sandbox", 7980, 7000, 564, true),
            cpus: 4,
            memory_mb: 4096,
            disks: vec![
                Disk { path: r"C:\vm\system.vhdx".into(), read_only: false },
                Disk { path: r"C:\vm\sessiondata.vhdx".into(), read_only: false },
            ],
            shares: vec![
                Plan9Share { name: "psyche-meta".into(), path: r"C:\vm\guest".into(), read_only: true },
                Plan9Share { name: "proj".into(), path: r"D:\proj".into(), read_only: false },
            ],
            plan9_port: 564,
            vsock_ports: vec![7980, 7000],
            console_pipe: Some(r"\\.\pipe\psyche-vm-console-x".into()),
            network: None,
            restore_from: None,
        }
    }

    #[test]
    fn service_ids_map_vsock_ports() {
        assert_eq!(vsock_service_id(7980), "00001f2c-facb-11e6-bd58-64006a7986d3");
        assert_eq!(vsock_service_id(7000), "00001b58-facb-11e6-bd58-64006a7986d3");
        assert_eq!(vsock_service_id(564), "00000234-facb-11e6-bd58-64006a7986d3");
    }

    #[test]
    fn compute_system_document() {
        let v = doc().to_json();
        assert_eq!(v["Owner"], "psyche-vm-abc");
        assert_eq!(v["SchemaVersion"], json!({"Major": 2, "Minor": 5}));
        assert_eq!(v["ShouldTerminateOnLastHandleClosed"], true);
        let vm = &v["VirtualMachine"];
        assert_eq!(vm["StopOnReset"], true);
        let k = &vm["Chipset"]["LinuxKernelDirect"];
        assert_eq!(k["KernelFilePath"], r"C:\img\vmlinuz");
        assert_eq!(k["InitRdPath"], r"C:\img\initrd");
        assert!(k["KernelCmdLine"].as_str().unwrap().contains("psyche.gateway_port=7980"));
        assert_eq!(vm["ComputeTopology"]["Memory"], json!({"SizeInMB": 4096, "AllowOvercommit": true}));
        assert_eq!(vm["ComputeTopology"]["Processor"]["Count"], 4);
        let scsi = &vm["Devices"]["Scsi"]["0"]["Attachments"];
        assert_eq!(scsi["0"], json!({"Type": "VirtualDisk", "Path": r"C:\vm\system.vhdx", "ReadOnly": false}));
        assert_eq!(scsi["1"]["Path"], r"C:\vm\sessiondata.vhdx");
        let hv = &vm["Devices"]["HvSocket"]["HvSocketConfig"];
        assert_eq!(hv["DefaultBindSecurityDescriptor"], SYSTEM_ONLY_SD);
        assert_eq!(hv["DefaultConnectSecurityDescriptor"], SYSTEM_ONLY_SD);
        assert_eq!(hv["ServiceTable"]["00001f2c-facb-11e6-bd58-64006a7986d3"]["BindSecurityDescriptor"], SYSTEM_ONLY_SD);
        let shares = vm["Devices"]["Plan9"]["Shares"].as_array().unwrap();
        assert_eq!(shares[0], json!({"Name": "psyche-meta", "AccessName": "psyche-meta", "Path": r"C:\vm\guest", "Port": 564, "Flags": 1}));
        assert_eq!(shares[1]["Flags"], 0);
        assert_eq!(vm["Devices"]["ComPorts"]["0"]["NamedPipe"], r"\\.\pipe\psyche-vm-console-x");
        assert!(vm["Devices"].get("NetworkAdapters").is_none(), "no network by default");
        assert!(vm.get("RestoreState").is_none());
    }

    #[test]
    fn nat_and_warm_start() {
        let mut d = doc();
        d.network = Some(("6f1c…".into(), "00:15:5d:01:02:0a".into()));
        d.restore_from = Some(r"C:\vm\SavedState.vmrs".into());
        let v = d.to_json();
        assert_eq!(
            v["VirtualMachine"]["Devices"]["NetworkAdapters"]["6f1c…"],
            json!({"EndpointId": "6f1c…", "MacAddress": "00-15-5D-01-02-0A"})
        );
        assert_eq!(v["VirtualMachine"]["RestoreState"], json!({"SaveStateFilePath": r"C:\vm\SavedState.vmrs"}));
    }

    #[test]
    fn modify_and_option_documents() {
        let s = Plan9Share { name: "proj".into(), path: r"D:\p".into(), read_only: true };
        assert_eq!(
            add_share_request(&s, 564),
            json!({"ResourcePath": "VirtualMachine/Devices/Plan9/Shares", "RequestType": "Add", "Settings": {"Name": "proj", "AccessName": "proj", "Path": r"D:\p", "Port": 564, "Flags": 1}})
        );
        assert_eq!(remove_share_request("proj", 564)["RequestType"], "Remove");
        assert_eq!(save_options(r"C:\s.vmrs"), json!({"SaveType": "ToFile", "SaveStateFilePath": r"C:\s.vmrs"}));
        assert_eq!(shutdown_options()["Mechanism"], "IntegrationService");
        let c = kernel_cmdline(Some("console=hvc0 root=/dev/sda"), "sandbox", 7980, 7000, 564, false);
        assert_eq!(
            c,
            "console=hvc0 root=/dev/sda psyche.vm=sandbox psyche.gateway_port=7980 psyche.agent_port=7000 psyche.plan9_port=564 psyche.meta=psyche-meta"
        );
    }

    #[test]
    fn schema_choice() {
        let props = json!({"Properties": [{"SupportedSchemaVersions": [{"Major": 1, "Minor": 0}, {"Major": 2, "Minor": 1}, {"Major": 2, "Minor": 4}, {"Major": 2, "Minor": 7}]}]});
        assert_eq!(pick_schema(&props), Some((2, 4)));
        assert_eq!(pick_schema(&json!({"SupportedSchemaVersions": [{"Major": 2, "Minor": 1}]})), None);
        assert_eq!(hcs_mac("00:15:5d:ab:cd:ef"), "00-15-5D-AB-CD-EF");
    }
}
