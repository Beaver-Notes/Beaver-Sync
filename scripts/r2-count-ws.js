const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const s3 = new S3Client({ region: "us-east-1", endpoint: "http://localhost:9000", forcePathStyle: true, credentials: { accessKeyId: "beaver", secretAccessKey: "beaver-dev-secret" } });
(async () => {
  let listed = [], token;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: "beaver-sync", ContinuationToken: token }));
    for (const o of res.Contents || []) listed.push({ key: o.Key, size: o.Size });
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  const ws = listed.filter((o) => o.key.startsWith("ws-assets/4bff239a-3582-4e53-a16b-463f7bdb9c02/"));
  console.log("ws_objects:", ws.length, "ws_bytes:", ws.reduce((a, o) => a + o.size, 0));
  for (const o of ws) console.log(" -", o.key.split("--").pop(), o.size);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
