const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const s3 = new S3Client({ region: "us-east-1", endpoint: "http://localhost:9000", forcePathStyle: true, credentials: { accessKeyId: "beaver", secretAccessKey: "beaver-dev-secret" } });
(async () => {
  let n = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: "beaver-sync", ContinuationToken: token }));
    for (const o of r.Contents || []) if (o.Key.includes("iV-so8i2ZF4Yoj5Pv9ph9AsBGz1huuF4p_BLV_JYTRI")) n.push({ key: o.Key, size: o.Size, last: o.LastModified?.toISOString() });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  console.log(JSON.stringify(n, null, 0), "count:", n.length);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
