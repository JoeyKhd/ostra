import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Throwaway certificates for one run, made with the openssl CLI:
// - the server's own CA and its leaf (what a self-hosted install would have)
// - a "corporate" CA and the leaf a TLS-inspecting proxy presents with it

export type Certs = {
  readonly serverCa: string;
  readonly serverCert: string;
  readonly serverKey: string;
  readonly corpCa: string;
  readonly corpLeafCert: string;
  readonly corpLeafKey: string;
  /** Server CA + corporate CA, for NODE_EXTRA_CA_CERTS. */
  readonly bundle: string;
};

export const SERVER_HOST = "ostra-core.test";

const exists = async (file: string): Promise<boolean> => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

export const opensslBin = async (): Promise<string> => {
  const fromEnv = process.env["OPENSSL_BIN"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const gitOpenssl = "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe";
  if (process.platform === "win32" && (await exists(gitOpenssl))) return gitOpenssl;
  return "openssl";
};

const run = async (args: readonly string[], cwd: string): Promise<void> => {
  const bin = await opensslBin();
  await new Promise<void>((resolve, reject) => {
    execFile(bin, args, { cwd, windowsHide: true }, (err) => {
      if (err === null) resolve();
      else reject(new Error(`openssl ${args[0] ?? ""} failed`));
    });
  });
};

const ca = async (dir: string, name: string): Promise<void> => {
  await run(
    [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", `${name}.key`, "-out", `${name}.crt`, "-days", "2", "-subj", `/CN=${name}`,
      "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    ],
    dir,
  );
};

const leaf = async (dir: string, name: string, caName: string): Promise<void> => {
  await writeFile(
    path.join(dir, `${name}.ext`),
    [
      `subjectAltName=DNS:localhost,DNS:${SERVER_HOST},IP:127.0.0.1`,
      "basicConstraints=CA:FALSE",
      "keyUsage=digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "",
    ].join("\n"),
  );
  await run(
    [
      "req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${SERVER_HOST}`,
    ],
    dir,
  );
  await run(
    [
      "x509", "-req", "-in", `${name}.csr`, "-CA", `${caName}.crt`, "-CAkey", `${caName}.key`,
      "-CAcreateserial", "-out", `${name}.crt`, "-days", "2", "-extfile", `${name}.ext`,
    ],
    dir,
  );
};

export const makeCerts = async (dir: string): Promise<Certs> => {
  await mkdir(dir, { recursive: true });
  await ca(dir, "server-ca");
  await leaf(dir, "server", "server-ca");
  await ca(dir, "corp-ca");
  await leaf(dir, "corp-leaf", "corp-ca");
  const bundle = path.join(dir, "bundle.crt");
  const [a, b] = await Promise.all([readFile(path.join(dir, "server-ca.crt"), "utf8"), readFile(path.join(dir, "corp-ca.crt"), "utf8")]);
  await writeFile(bundle, `${a}\n${b}`);
  return {
    serverCa: path.join(dir, "server-ca.crt"),
    serverCert: path.join(dir, "server.crt"),
    serverKey: path.join(dir, "server.key"),
    corpCa: path.join(dir, "corp-ca.crt"),
    corpLeafCert: path.join(dir, "corp-leaf.crt"),
    corpLeafKey: path.join(dir, "corp-leaf.key"),
    bundle,
  };
};
