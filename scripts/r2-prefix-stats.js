const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const s3 = new S3Client({ region: "us-east-1", endpoint: "http://localhost:9000", forcePathStyle: true, credentials: { accessKeyId: "beaver", secretAccessKey: "beaver-dev-secret" } });
(async () => {
  let listed = [], token;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: "beaver-sync", ContinuationToken: token }));
    listed.push(...(res.Contents || []));
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  const cm = listed.filter((o) => o.Key.includes("cm82G9"));
  const underWs = cm.filter((o) => o.Key.startsWith("ws-assets/"));
  const underAcct = cm.filter((o) => !o.Key.startsWith("ws-assets/"));
  console.log("cm82_total:", cm.length, "ws_scheme:", underWs.length, "account_scheme:", underAcct.length);
  const heavy15 = listed.filter((o) => o.Key.includes("heavy") || o.Key.includes("iV-so8i2"));
  console.log("heavy15_scheme:", heavy15.map((o) => o.Key.split("/")[0]).join(","));
  console.log("total_objects:", listed.length);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
