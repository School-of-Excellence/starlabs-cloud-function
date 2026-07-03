const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const cors = require("cors")({ origin: true });

const commonService = require('./service');
const AWS_S3Request = require("@aws-sdk/s3-request-presigner")
const AWS_ClientS3 = require("@aws-sdk/client-s3");

const AWS_ACCESS_KEY = defineSecret("AWS_ACCESS_KEY");
const AWS_SECRET = defineSecret("AWS_SECRET");

exports.getSignedUrlAWS = onRequest({ secrets: [AWS_ACCESS_KEY, AWS_SECRET] }, async (req, res) => {
  cors(req, res, async () => {
    if (req.method !== "POST") {
      return res.status(405).json({error: "Method Not Allowed. Only POST allowed"});
    }

    const { videoKey } = req.body;
    if (!videoKey) {
      return res.status(400).json({
        error: "Video Key is required",
      });
    }

    try {
      const awsAccessKey = AWS_ACCESS_KEY.value();
      const awsSecret = AWS_SECRET.value();

      const s3 = new AWS_ClientS3.S3Client({
        region: "ap-south-1",
        credentials: {
          accessKeyId: awsAccessKey,
          secretAccessKey: awsSecret,
        },
      });

      const command = new AWS_ClientS3.GetObjectCommand({
        Bucket: commonService.production ? "openvidu-meet-recordings-prod" : "openvidu-meet-recordings-dev",
        Key: videoKey,
      });

      const url = await AWS_S3Request.getSignedUrl(s3, command, { expiresIn: 300 }); // 5 min
      res.status(200).json({ url });
    } catch (error) {
      console.error("Unable to Get Signed URL:", error);
      return res.status(500).json({ error: error.message || error.toString() });
    }
  })
});
