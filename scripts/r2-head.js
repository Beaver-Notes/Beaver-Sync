const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const s3 = new S3Client({ region: "us-east-1", endpoint: "http://localhost:9000", forcePathStyle: true, credentials: { accessKeyId: "beaver", secretAccessKey: "beaver-dev-secret" } });
(async () => {
  const k = "ws-assets/4bff239a-3582-4e53-a16b-463f7bdb9c02/assets--4bff239a-3582-4e53-a16b-463f7bdb9c02--T_2Tr3olVQDIiy_Rwm20g--kEVk5bqdqhprFDEcGZcdwh4bIVuFpQdbVQYZCfPQiPc";
  const r = await s3.send(new GetObjectCommand({ Bucket: "beaver-sync", Key: k }));
  const buf = Buffer.from(await r.Body.transformToByteArray());
  const raw = Buffer.from(buf.toString("utf8"), "base64");
  const head = raw.subarray(0, 200).toString("utf8");
  const tail = raw.subarray(-60).toString("utf8");
  console.log(JSON.stringify({ head, tail, total: raw.length }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
