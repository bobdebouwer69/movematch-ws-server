// server.mjs

import http from "http";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";
import {
  DynamoDBClient
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand
} from "@aws-sdk/lib-dynamodb";
import {
  SecretsManagerClient,
  GetSecretValueCommand
} from "@aws-sdk/client-secrets-manager";

// Load secrets from AWS Secrets Manager
const secretsClient = new SecretsManagerClient({ region: "eu-north-1" });
const secretData = await secretsClient.send(
  new GetSecretValueCommand({
    SecretId: "movematch/websocket/env",
  })
);
const secrets = JSON.parse(secretData.SecretString);

const REGION = "eu-north-1";
const USER_POOL_ID = secrets.COGNITO_USER_POOL_ID;
const CLIENT_ID = secrets.COGNITO_CLIENT_ID;
const CONNECTIONS_TABLE = secrets.CONNECTIONS_TABLE;
const MESSAGES_TABLE = secrets.MESSAGES_TABLE;

// DynamoDB client
const client = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(client);

// Cognito JWKS setup
const jwks = jwksClient({
  jwksUri: `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}/.well-known/jwks.json`,
});

function getKey(header, callback) {
  jwks.getSigningKey(header.kid, function (err, key) {
    const signingKey = key.getPublicKey();
    callback(null, signingKey);
  });
}

async function verifyToken(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      getKey,
      {
        audience: CLIENT_ID,
        issuer: `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`,
        algorithms: ["RS256"],
      },
      (err, decoded) => {
        if (err) return reject(err);
        resolve(decoded);
      }
    );
  });
}

// Create HTTP server + WebSocket server
const httpServer = http.createServer();
const io = new Server(httpServer, {
  cors: {
    origin: "*", // Change this in production
    methods: ["GET", "POST"],
  },
});

// Handle socket connections
io.on("connection", async (socket) => {
  let userId;

  try {
    const token = socket.handshake.auth?.token;
    if (!token) throw new Error("❌ No token provided");

    const decoded = await verifyToken(token);
    userId = decoded.sub;

    console.log("✅ Authenticated user:", userId);
  } catch (err) {
    console.error("❌ Authentication failed:", err.message);
    return socket.disconnect(true);
  }

  await ddb.send(
    new PutCommand({
      TableName: CONNECTIONS_TABLE,
      Item: {
        connectionId: socket.id,
        userId: userId,
      },
    })
  );

  socket.on("send_message", async ({ toUserId, message }) => {
    const conversationId = [userId, toUserId].sort().join("_");

    const item = {
      conversationId,
      timestamp: new Date().toISOString(),
      senderId: userId,
      recipientId: toUserId,
      message,
      read: false,
    };

    await ddb.send(
      new PutCommand({
        TableName: MESSAGES_TABLE,
        Item: item,
      })
    );

    for (const [_, s] of io.sockets.sockets) {
      if (s.userId === toUserId) {
        s.emit("receive_message", item);
      }
    }
  });

  socket.on("disconnect", async () => {
    console.log("❌ Disconnected:", userId);

    try {
      await ddb.send(
        new DeleteCommand({
          TableName: CONNECTIONS_TABLE,
          Key: { connectionId: socket.id },
        })
      );
      console.log("🧹 Cleaned up connection:", socket.id);
    } catch (err) {
      console.error("❌ Failed to delete connection:", err);
    }
  });

  socket.userId = userId;
});

// Start the server
httpServer.listen(3000, () => {
  console.log("🚀 WebSocket Server running on http://localhost:3000");
});
