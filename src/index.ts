import express from 'express';
import puppeteer from 'puppeteer-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import {Eureka} from 'eureka-js-client';
import os from 'os';

puppeteer.use(stealthPlugin());

const app = express();
app.use(express.json());

import Redis from 'ioredis';
import {courierFunctions, TrackingData} from './scrapers';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

const {
    EUREKA_APP_NAME = 'scraper-puppeteer-svc',
    EUREKA_INSTANCE_PORT = '4000',
    EUREKA_INSTANCE_HOST = os.hostname(),
    EUREKA_INSTANCE_IP = '127.0.0.1',
    EUREKA_SERVER_HOST = 'localhost',
    EUREKA_SERVER_PORT = '8761',
    EUREKA_SERVICE_PATH = '/eureka/apps/',
} = process.env;

const instanceId = `${EUREKA_APP_NAME}-${EUREKA_INSTANCE_HOST}-${EUREKA_INSTANCE_PORT}-${process.pid}`;

// Eureka client configuration
const eurekaClient = new Eureka({
    instance: {
        app: EUREKA_APP_NAME,
        instanceId,
        hostName: EUREKA_INSTANCE_HOST,
        ipAddr: EUREKA_INSTANCE_IP,
        port: {
            $: parseInt(EUREKA_INSTANCE_PORT, 10),
            '@enabled': true,
        },
        vipAddress: EUREKA_APP_NAME,
        dataCenterInfo: {
            '@class': 'com.netflix.appinfo.InstanceInfo$DefaultDataCenterInfo',
            name: 'MyOwn',
        },
    },
    eureka: {
        host: EUREKA_SERVER_HOST,
        port: parseInt(EUREKA_SERVER_PORT, 10),
        servicePath: EUREKA_SERVICE_PATH,
    },
});

const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.5735.133 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; rv:109.0) Gecko/20100101 Firefox/115.0',
    'Mozilla/5.0 (Linux; Android 10; SM-G975F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Mobile Safari/537.36',
];


const getTrackingData = async (resi: string, courier: string): Promise<TrackingData[]> => {
    const redisKey = `puppeteer:getTrackingData:${courier}:${resi}`;

    // ✅ Try fetching from Redis cache
    const cached = await redis.get(redisKey);
    if (cached) {
        return JSON.parse(cached);
    }

    // Check if courier function exists, default to cekresi
    const scraper = courierFunctions[courier] || courierFunctions['cekresi'];

    // 🧭 Scraping logic (only runs if cache is empty)
    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1280,1024',
        ],
        defaultViewport: {
            width: 1280,
            height: 1024,
        },
    });

    try {
        const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
        const page = await browser.newPage();
        await page.setUserAgent(randomUserAgent);

        // Use the appropriate courier function
        const rows = await scraper({resi, courier}, page);

        // 💾 Cache to Redis (TTL = 5 minutes)
        await redis.set(redisKey, JSON.stringify(rows), 'EX', 300);

        return rows;
    } finally {
        await browser.close();
    }
};


// Health check endpoint with detailed metrics
app.get('/health', (req: express.Request, res: express.Response) => {
    res.status(200).json({
        status: 'UP',
        timestamp: new Date().toISOString(),
        service: EUREKA_APP_NAME,
        instanceId
    });
});


// REST endpoint with enhanced error handling
app.get('/track', async (req: express.Request, res: express.Response) => {
    const resi = req.query.resi as string;
    const courier = req.query.courier as string;
    const startTime = Date.now();

    if (!resi || !courier) {
        return res.status(400).json({
            error: 'Missing required query parameters: ?resi= & ?courier=',
            instanceId
        });
    }

    try {
        const result = await getTrackingData(resi, courier);

        res.json({
            resi,
            courier,
            result,
            instanceId,
            processingTime: Date.now() - startTime
        });
    } catch (err) {
        console.error('Tracking error:', err);
        res.status(500).json({
            error: 'Failed to track resi',
            details: (err as Error).message,
            instanceId,
            processingTime: Date.now() - startTime
        });
    }
});

// Graceful shutdown
const gracefulShutdown = async () => {
    console.log('🔄 Received shutdown signal. Shutting down gracefully...');

    // Stop accepting new requests
    const server = app.listen();
    server.close();


    // Deregister from Eureka
    if (process.env.ENABLE_EUREKA === 'true') {
        eurekaClient.stop(() => {
            console.log('📤 Deregistered from Eureka');
            process.exit(0);
        });
    }
};

// Handle shutdown signals
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

function startServer() {
    app.listen(EUREKA_INSTANCE_PORT, () => {
        console.log(`✅ Server running at http://localhost:${EUREKA_INSTANCE_PORT}`);


        // Start Eureka client
        if (process.env.ENABLE_EUREKA === 'true') {
            eurekaClient.start((error) => {
                if (error) {
                    console.error('❌ Failed to register with Eureka:', error.message);
                } else {
                    console.log(`🆔 Instance ID: ${instanceId}`);
                    console.log(`🏠 Hostname: ${EUREKA_INSTANCE_HOST}`);
                    console.log(`🌐 IP Address: ${EUREKA_INSTANCE_IP}`);
                    console.log(`📋 Service Name: ${EUREKA_APP_NAME}`);
                    console.log(`🔍 Eureka Server: http://${EUREKA_SERVER_HOST}:${EUREKA_SERVER_PORT}`);
                    console.log('🎯 Successfully registered with Eureka!');
                }
            });
        }
    });
}

startServer();

// Environment variables example (.env file)
/*
PORT=3000
SERVICE_NAME=tracking-service
EUREKA_HOST=localhost
EUREKA_PORT=8761
HOST_NAME=tracking-node-1
IP_ADDRESS=192.168.1.100
INSTANCE_ID=tracking-service-node-1-3000-12345
CLUSTER_MODE=true
NUM_WORKERS=4
MAX_CONCURRENT_REQUESTS=10
REQUEST_TIMEOUT=30000
CIRCUIT_BREAKER_THRESHOLD=5
MAX_BROWSERS=3
*/