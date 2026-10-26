const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const s3 = new S3Client({ region: "us-east-1", endpoint: "http://localhost:9000", forcePathStyle: true, credentials: { accessKeyId: "beaver", secretAccessKey: "beaver-dev-secret" } });
(async () => {
  let all = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: "beaver-sync", ContinuationToken: token }));
    all.push(...(r.Contents || []));
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  const ya = all.filter(o => o.Key.includes("YCffM3DooE6f_Cj4n3soMiHNaFf3ffdSASoDHHA3YMY"));
  const qg = all.filter(o => o.Key.includes("QGHYcygi_3gwrFuCK0u_yF3lb4um_rzKuOJzkPe9Iqs"));
  const fmt = (arr) => arr.map(o => ({ key: o.Key.split("assets--")[1].slice(0, 60), size: o.Size }));
  console.log("YCff (55,924,328B asset):", JSON.stringify(fmt(ya)));
  console.log("QGHY (11,185,084B asset):", JSON.stringify(fmt(qg)));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
