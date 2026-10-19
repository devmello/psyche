#!/usr/bin/env python3
"""Egress over a published Unix socket, so the sandbox keeps `--network none` (spike-02).

Apple `container --publish-socket HOST_PATH:CTR_PATH` lets the host connect to a socket the
container listens on, but not the other way round. This bridge turns that into outbound
connections with a reverse pool:

  shim   (inside the sandbox, UID 1000)  listens on CTR_PATH for idle connections from the
         host, and on 127.0.0.1:3128 / 127.0.0.1:1080 for the sandbox's own clients. Each new
         client takes one idle host connection, sends one byte (H = HTTP proxy, S = SOCKS5)
         and the two are spliced.
  dialer (on the host)  keeps POOL idle connections open to HOST_PATH; when one receives its
         selector byte it connects to the host-side proxy.py on 127.0.0.1 and splices, then
         opens a replacement.

The sandbox gets no IP route to the host or anything else; everything it can reach goes
through proxy.py's allowlist. Python 3.10+ stdlib only.

Usage: socket-bridge.py shim /tmp/egress.sock
       socket-bridge.py dialer /short/host/path.sock [--pool 8] [--http 3128] [--socks 1080]
"""

import argparse
import asyncio


async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, OSError):
        pass
    finally:
        writer.close()


async def shim(path):
    idle = asyncio.Queue()

    async def on_host_conn(r, w):
        await idle.put((r, w))

    def on_client(selector):
        async def handle(cr, cw):
            try:
                hr, hw = await asyncio.wait_for(idle.get(), 10)
            except asyncio.TimeoutError:
                cw.close()  # no host connection available: the host side is not running
                return
            hw.write(selector)
            await hw.drain()
            await asyncio.gather(pipe(cr, hw), pipe(hr, cw))
        return handle

    servers = [
        await asyncio.start_unix_server(on_host_conn, path),
        await asyncio.start_server(on_client(b"H"), "127.0.0.1", 3128),
        await asyncio.start_server(on_client(b"S"), "127.0.0.1", 1080),
    ]
    print(f"shim: host pool on {path}; clients on 127.0.0.1:3128 (http) and :1080 (socks5)", flush=True)
    await asyncio.gather(*(s.serve_forever() for s in servers))


async def dialer(path, pool, http_port, socks_port):
    async def one():
        while True:
            try:
                r, w = await asyncio.open_unix_connection(path)
            except OSError:
                await asyncio.sleep(0.5)  # container not up yet, or restarting
                continue
            sel = await r.read(1)
            if not sel:
                w.close()  # host end of the published socket exists but nobody listens yet
                await asyncio.sleep(0.2)
                continue
            asyncio.create_task(serve(r, w, sel))  # replace this pool slot right away

    async def serve(r, w, sel):
        port = http_port if sel == b"H" else socks_port
        try:
            ur, uw = await asyncio.open_connection("127.0.0.1", port)
        except OSError:
            w.close()
            return
        await asyncio.gather(pipe(r, uw), pipe(ur, w))

    print(f"dialer: {pool} idle connections to {path} -> 127.0.0.1:{http_port}/{socks_port}", flush=True)
    await asyncio.gather(*(one() for _ in range(pool)))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["shim", "dialer"])
    ap.add_argument("path")
    ap.add_argument("--pool", type=int, default=8)
    ap.add_argument("--http", type=int, default=3128)
    ap.add_argument("--socks", type=int, default=1080)
    a = ap.parse_args()
    try:
        asyncio.run(shim(a.path) if a.mode == "shim" else dialer(a.path, a.pool, a.http, a.socks))
    except KeyboardInterrupt:
        pass
