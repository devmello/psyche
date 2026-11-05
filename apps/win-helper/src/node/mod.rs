//! The node runtime: wire framing, the named-pipe transport, the handshake, device identity, the
//! capability registry and the serve loop. Nothing here knows about a particular capability group.

pub mod cancel;
pub mod capability;
pub mod channel;
pub mod daemon;
pub mod encoding;
pub mod frames;
pub mod handshake;
pub mod identity;
pub mod instance;
pub mod log;
pub mod ndjson;
pub mod paths;
pub mod registry;
pub mod roots;
pub mod schema;
pub mod session;
pub mod tiers;
pub mod time;
pub mod transport;

pub use capability::{
    CapResult, CapabilityError, CapabilityOutput, CapabilitySpec, ErrorCode, InvocationContext, OsPermission, ReceiptDraft, SideEffect,
    TargetKind,
};
pub use registry::{CapabilityRegistry, Runtime};
