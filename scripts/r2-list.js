// List S3 objects for the three heavy-file asset keys (object-level proof of
// exactly one PUT/asset). Read-only; safe scratch script.
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const s3 = new S3Client({
  region: "us-east-1",
  endpoint: "http://localhost:9000", // seaweed S3 exposed? try host mapping
  forcePathStyle: true,
  credentials: { accessKeyId: "beaver", secretAccessKey: "beaver-dev-secret" },
});
const keys = [
  "kEVk5bqdqhprFDEcGZcdwh4bIVuFpQdbVQYZCfPQiPc",
  "V8pjdvMPuOTHDz", // partial match helper
  "yD1Rs9l7CJpDeixDyCecrH5Peg8cNuJBMSF7Ou8XGgU",
];
(async () => {
  let listed = [];
  let token;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: "beaver-sync", ContinuationToken: token }));
    for (const o of res.Contents || []) {
      listed.push({ key: o.Key, size: o.Size, etag: o.ETag, last: o.LastModified?.toISOString() });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  const match = listed.filter((o) => o.key.includes("T_2Tr3o"));
  console.log("total_objects:", listed.length);
  console.log("heavy_note_objects:", JSON.stringify(match, null, 0));
  const other = listed.filter((o) => !o.key.includes("T_2Tr3o"));
  console.log("other_objects:", JSON.stringify(other.slice(0, 12), null, 0), "...,", other.length, "total others");
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
