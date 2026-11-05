//! The live Outlook backend: late-bound COM on a dedicated STA thread.

pub mod dispatch;
mod live;
mod live_pim;
pub mod sink;
pub mod sta;

pub use live::LiveOutlook;

#[cfg(test)]
mod live_tests;
