FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

# Copy package files and install only production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the compiled output from builder
COPY --from=builder /app/dist ./dist

# Create a non-root user
RUN addgroup -S nestjs && adduser -S nestjs -G nestjs
RUN chown -R nestjs:nestjs /app
USER nestjs

# Expose the application port
EXPOSE 7003

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:7003/health || exit 1

# Start the application
CMD ["node", "dist/main.js"]
