mod artifacts;
mod common;
mod desktop;
mod governance;
mod policy;
mod remote;
mod storage;
mod targets;
mod workspace;

pub mod proto {
    tonic::include_proto!("tanwei.protocol.v1");
}

pub fn run() {
    desktop::run();
}
