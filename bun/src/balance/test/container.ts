import { GenericContainer, Wait } from "testcontainers";
import { type Client, createClient } from "tigerbeetle-node";

// One TigerBeetle for the whole test run: started lazily on first use, shared by every test
// (the standalone TigerBeetleBalance tests and the parametrized handler suite), and reaped by
// testcontainers (Ryuk) on exit. A single shared client too — TigerBeetle caps concurrent
// clients per cluster, and a client-per-test under `test.concurrent` would blow past it.
//
// The image tag MUST match the tigerbeetle-node client version (client and cluster are
// released in lockstep). Notes on the flags:
//   --development            relaxes the production direct-I/O / memory-locking requirements
//                            and shrinks the grid cache, so it runs inside a container cheaply.
//   privileged mode          disables the default seccomp profile, which otherwise blocks the
//                            io_uring syscalls TigerBeetle needs (you'd see "io_uring is not
//                            available / PermissionDenied" without it).
// format and start are separate invocations (the data file must exist before start), chained
// through a shell since the image ships one (busybox) at /bin/sh with the binary at /tigerbeetle.
const IMAGE = "ghcr.io/tigerbeetle/tigerbeetle:0.17.7";
const PORT = 3000;

let clientP: Promise<Client> | undefined;

export function sharedTigerBeetle(): Promise<Client> {
  return (clientP ??= start());
}

async function start(): Promise<Client> {
  const container = await new GenericContainer(IMAGE)
    .withPrivilegedMode()
    .withEntrypoint(["/bin/sh", "-c"])
    .withCommand([
      `/tigerbeetle format --cluster=0 --replica=0 --replica-count=1 /tmp/0.tigerbeetle && ` +
      `exec /tigerbeetle start --development --addresses=0.0.0.0:${PORT} /tmp/0.tigerbeetle`,
    ])
    .withExposedPorts(PORT)
    .withWaitStrategy(Wait.forLogMessage(/listening on/))
    .withStartupTimeout(120_000)
    .start();

  // The client parses replica addresses as numeric IP:port — it rejects hostnames, and
  // testcontainers hands back "localhost", so normalise that to a loopback IP.
  const host = container.getHost();
  const ip = host === "localhost" ? "127.0.0.1" : host;
  return createClient({
    cluster_id: 0n,
    replica_addresses: [`${ip}:${container.getMappedPort(PORT)}`],
  });
}
