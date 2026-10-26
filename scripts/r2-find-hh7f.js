const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const s3 = new S3Client({ region: "us-east-1", endpoint: "http://localhost:9000", forcePathStyle: true, credentials: { accessKeyId: "beaver", secretAccessKey: "beaver-dev-secret" } });
(async () => {
  let listed = [], token;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: "beaver-sync", ContinuationToken: token }));
    for (const o of res.Contents || []) listed.push(o);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  const m = listed.filter((o) => o.Key.includes("HH7Fx8EEGpefJQHJ3"));
  console.log("hh7f_objects:", m.length);
  for (const o of m) console.log(" ", o.Size, o.Key.slice(0,120));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
