const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const s3 = new S3Client({ region: "us-east-1", endpoint: "http://localhost:9000", forcePathStyle: true, credentials: { accessKeyId: "beaver", secretAccessKey: "beaver-dev-secret" } });
(async () => {
  let listed = [], token;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: "beaver-sync", ContinuationToken: token }));
    for (const o of res.Contents || []) listed.push(o);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  const m = listed.filter((o) => o.Key.includes("cm82G9"));
  console.log("for_note:", m.length, "bytes:", m.reduce((a, o) => a + o.Size, 0));
  for (const o of m) console.log(" -", o.LastModified?.toISOString(), o.Key.split("--").pop(), o.Size);
  const lastmod = listed.slice().sort((a,b)=> b.LastModified - a.LastModified).slice(0, 5);
  console.log("newest_keys:"); for (const o of lastmod) console.log(" ", o.LastModified?.toISOString(), o.Key.slice(0,110), o.Size);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
