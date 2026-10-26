const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const crypto = require("crypto");
const fs = require("fs");
const s3 = new S3Client({
  region: "us-east-1",
  endpoint: "http://localhost:9000",
  forcePathStyle: true,
  credentials: { accessKeyId: "beaver", secretAccessKey: "beaver-dev-secret" },
});
const objs = [
  ["ws-assets/4bff239a-3582-4e53-a16b-463f7bdb9c02/assets--4bff239a-3582-4e53-a16b-463f7bdb9c02--T_2Tr3olVQDIiy_Rwm20g--kEVk5bqdqhprFDEcGZcdwh4bIVuFpQdbVQYZCfPQiPc", "heavy1.png"],
  ["ws-assets/4bff239a-3582-4e53-a16b-463f7bdb9c02/assets--4bff239a-3582-4e53-a16b-463f7bdb9c02--T_2Tr3olVQDIiy_Rwm20g--V8pjdvMPuOTHDz31J-qAup9-PoG3kj5WgGrRhJgYKoA", "heavy10.png"],
  ["ws-assets/4bff239a-3582-4e53-a16b-463f7bdb9c02/assets--4bff239a-3582-4e53-a16b-463f7bdb9c02--T_2Tr3olVQDIiy_Rwm20g--yD1Rs9l7CJpDeixDyCecrH5Peg8cNuJBMSF7Ou8XGgU", "heavy50.png"],
];
const local = "/Users/danielerolli/Documents/GitHub/Beaver-Notes/.duo/session-a/assets/T_2Tr3olVQDIiy_Rwm20g";
(async () => {
  for (const [k, name] of objs) {
    const r = await s3.send(new GetObjectCommand({ Bucket: "beaver-sync", Key: k }));
    const buf = Buffer.from(await r.Body.transformToByteArray());
    const decoded = buf.toString("utf8");            // body is base64 text
    const raw = Buffer.from(decoded, "base64");      // -> encrypted bytes
    const remote = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
    const localBuf = fs.readFileSync(`${local}/${name}`);
    const localSha = crypto.createHash("sha256").update(localBuf).digest("hex").slice(0, 16);
    console.log(name, "decodedSha", remote, "localEncSha", localSha, "match", remote === localSha, "sizes", raw.length, localBuf.length);
  }
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
