const { S3Client, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const crypto = require("crypto");
const fs = require("fs");
const s3 = new S3Client({ region: "us-east-1", endpoint: "http://localhost:9000", forcePathStyle: true, credentials: { accessKeyId: "beaver", secretAccessKey: "beaver-dev-secret" } });
const dir = "/Users/danielerolli/Documents/GitHub/Beaver-Notes/.duo/session-a/assets/cm82G9IMqx_oQ0mPQqUK-";
(async () => {
  let listed = [], token;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: "beaver-sync", ContinuationToken: token }));
    for (const o of res.Contents || []) listed.push(o);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  const m = listed.find((o) => o.Key.includes("cm82G9"));
  const body = Buffer.from(Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket: "beaver-sync", Key: m.Key }))).Body.transformToByteArray()).toString("utf8"), "base64");
  const target = crypto.createHash("sha256").update(body).digest("hex");
  console.log("remote encrypted size", body.length, "sha", target.slice(0, 12));
  for (const f of fs.readdirSync(dir)) {
    const buf = fs.readFileSync(`${dir}/${f}`);
    const h = crypto.createHash("sha256").update(buf).digest("hex");
    console.log(f, buf.length, h.slice(0, 12), h === target ? "  <-- MATCH" : "");
  }
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
