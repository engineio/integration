import { type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { SQL } from "bun";
import { createSign } from "node:crypto";

/**
 * A throwaway RSA keypair used only by the tests to stand in for the RGS. The
 * server is built with `testPublicKey`; requests are signed with `testPrivateKey`.
 */
export const testPrivateKey = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC4m2yfoJ01B9Ub
qV72X5eePhBNxiut7uMPnigOH5NDN1As5Kryj4mKQzmjs0qzqf3fykAl+fBKWDy/
TNmalMhTenyukkf0hdVXJQ/ErLt43beZi1gNHgop4epSP2BD3GUJGj287vHLE3T9
l5tcceUMUfi6MkOuG8lmpzSwyM6CPB0xKgNX94MOC6I0K5pX5dNgMoeI9vZedqcq
CwW3bRCpcSTxnBooFF1ev+OrcRGqQsltyvjIH8o264ootloQPVfGksKRzS+POsh7
zBzfVBOlVfXqiRokDOsYQuIWH87pO/eX/toC5tv7dJDDbiinySbtkOpnHOnxoTL/
i6SKRskfAgMBAAECggEAAiG8ipT1CJYjXkM01yBNEYUiwXZdLfacPwnsguOkDhqn
A/dM1UNv3l2rkYbFThEG3xa1Nu5AwBsH8icvb05YiESmolcK50Zd+FINPinG4HAI
nSIaAJmTZ6ucMRonDaGPgrnMcx1I3YRHM/mt0AHgsaVT4fj10lGv004K/1LST6t5
wl/SVUOpKGhN+PSVdmw424U5GfA4fwdvr3dQX2lghvWH18KirxvtouDlvafZNAcm
HUUI1ZkUEQJDN8c2EVz2hjkxxeTZszkU72+6CM9E0zCP9RZCP2Gaqa9YfQ9l0TJO
kTLHp4h/nXs7OpCXNKKqJz2DisPUwKiDpNNTm5pvQQKBgQD+ZwG7FoMuwwqB33dt
dFonGcH3i6A7glQXA/8fnQYXWFex16k9HDzDwj1c4/t6milSOWRMlLCPGD8P2Llo
gqAhN4ogaSvw+ctYd2e2W+6sSFs2/wg4R0PvF/05s8ranuJQW8+0rJnojKQqP/CW
pqUH5pMYIQ7FheBNGPMyVUv0EwKBgQC5xDXYIAkos4Hx5oLq7LfBeFcvZM6ZjsMz
bdOqdUcP70DSu3ps9qmdQymOTfUqDDEYnn+rT3jzg12nFcvhH0LdzV6wifmaBrFp
42yQAZopX3yocT+ed1r3GZJRYUmymd5VaBvqGiw5ZKZ8Xe+2H1u8a8Ws1bE27X1p
xwLrzboARQKBgAJPRxm+u5QqGydQsxHgU401U6h+sQa5STAoTiGoWEzP9YPc1GGE
pxyT3+C/BSJ40dU4RivX0b6K1s+7BPvo67FBgtSGf+qhKfJ0qxFhxkn0IjfemuF/
7CL4kcj7U+UmOiHGo50dUAxncnobuIB1pNvsgPtgGXU7oOyyREr5sUXXAoGBAIte
OUc8QaLXidYCKpY1ombz8fUMnDN4d9pNu09XTUkXJnrzTJYTOI1TpgmtUxGItAzU
XNQZe5S2Kb0BDUSIP5JIUZIA8dIs002t4fToPtBrYwq8bA5nXUelV7DWXIQyDCvn
P4oSuLsWWBFWKFFqlVh3Qoa4i4u6AS0qsXZXkgRBAoGBAId+LIHdYpzpNupbPHdA
Oq0HH35li//QobKHFMxBDqCTHIVqT0ujs890E6nWwiRf+N5vTNPxp03i86R1zrut
R3Ddil94MF1W2u4rQBOdn0b3VcYnTPHyUQVQic+hOMDTN6xz0l83EZMCCmUIWkPp
g32x5+A+JLH1rqugu66jyE1W
-----END PRIVATE KEY-----
`;

export const testPublicKey = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuJtsn6CdNQfVG6le9l+X
nj4QTcYrre7jD54oDh+TQzdQLOSq8o+JikM5o7NKs6n938pAJfnwSlg8v0zZmpTI
U3p8rpJH9IXVVyUPxKy7eN23mYtYDR4KKeHqUj9gQ9xlCRo9vO7xyxN0/ZebXHHl
DFH4ujJDrhvJZqc0sMjOgjwdMSoDV/eDDguiNCuaV+XTYDKHiPb2XnanKgsFt20Q
qXEk8ZwaKBRdXr/jq3ERqkLJbcr4yB/KNuuKKLZaED1XxpLCkc0vjzrIe8wc31QT
pVX16okaJAzrGELiFh/O6Tv3l/7aAubb+3SQw24op8km7ZDqZxzp8aEy/4ukikbJ
HwIDAQAB
-----END PUBLIC KEY-----`;

/** Build a signed `fetch` request init, mirroring how the RGS signs request bodies. */
export function signed<T extends object>(body: T): RequestInit {
  const payload = JSON.stringify(body);
  const signature = createSign("RSA-SHA256").update(payload).sign(testPrivateKey, "base64");
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
