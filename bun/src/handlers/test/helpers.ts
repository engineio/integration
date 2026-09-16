import { type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { SQL } from "bun";
import { sign } from "node:crypto";

/**
 * A throwaway Ed25519 keypair used only by the tests to stand in for the RGS. The
 * server is built with `testPublicKey`; requests are signed with `testPrivateKey`.
 */
export const testPrivateKey = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIPBbszAURPwNCTpaR9ewAI595ZpjPB5oLjdrImRKxMOv
-----END PRIVATE KEY-----
`;

export const testPublicKey = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAmIhwk/HnCu50k7ciachZst7DM4hB4IeyM/GEr8h6tTU=
-----END PUBLIC KEY-----`;

/** Build a signed `fetch` request init, mirroring how the RGS signs request bodies:
 *  Ed25519 over the raw body bytes, standard base64. */
export function signed<T extends object>(body: T): RequestInit {
  const payload = JSON.stringify(body);
  const signature = sign(null, Buffer.from(payload), testPrivateKey).toString("base64");
  return {
    method: "POST",
    headers: { "x-signature": signature, "content-type": "application/json" },
    body: payload,
  };
}




/**
 * Create an isolated database on the given Postgres container and return a connection to
 * it plus a `destroy` that drops it — one container, many test databases. It does NOT
 * migrate; the caller wires the connection into the repos and runs migrations itself.
 *
 * Small pools keep many concurrent tests well under Postgres' connection limit.
 */
export async function createTestDb(container: StartedPostgreSqlContainer): Promise<[SQL, () => Promise<void>]> {
  const dsn = `postgres://${container.getUsername()}:${container.getPassword()}@${container.getHost()}:${container.getPort()}`;
  const database = `test_${Math.random().toString(36).slice(2, 12)}`;

  const admin = new SQL({ url: `${dsn}/postgres`, max: 1 });
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  await admin.end(); // don't hold an admin connection for the test's lifetime

  const sql = new SQL({ url: `${dsn}/${database}`, max: 4 });

  const destroy = async () => {
    await sql.end();
    const cleaner = new SQL({ url: `${dsn}/postgres`, max: 1 });
    await cleaner.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid()`,
    );
    await cleaner.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await cleaner.end();
  };

  return [sql, destroy];
}
