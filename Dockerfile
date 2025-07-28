# Use official Node.js image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the source code
COPY . .

# Expose port (match what your server uses)
EXPOSE 3000

# Start the WebSocket server
CMD ["node", "server.mjs"]
