import express from 'express';
import puppeteer from 'puppeteer-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import {Eureka} from 'eureka-js-client';
import os from 'os';

puppeteer.use(stealthPlugin());

const app = express();
app.use(express.json());

import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
// Scaling configuration
const NUM_WORKERS = process.env.NUM_WORKERS ? parseInt(process.env.NUM_WORKERS) : os.cpus().length;

// Rate limiting and circuit breaker settings
const MAX_CONCURRENT_REQUESTS = parseInt(process.env.MAX_CONCURRENT_REQUESTS ?? '10');
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT ?? '30000');
const CIRCUIT_BREAKER_THRESHOLD = parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD ?? '5');

let currentRequests = 0;
let failureCount = 0;
let circuitBreakerOpen = false;
let lastFailureTime = 0;


// Circuit breaker logic
function isCircuitBreakerOpen(): boolean {
    if (circuitBreakerOpen) {
        // Reset circuit breaker after 60 seconds
        if (Date.now() - lastFailureTime > 60000) {
            circuitBreakerOpen = false;
            failureCount = 0;
            console.log('🔄 Circuit breaker reset');
        }
    }
    return circuitBreakerOpen;
}

function recordFailure() {
    failureCount++;
    lastFailureTime = Date.now();
    if (failureCount >= CIRCUIT_BREAKER_THRESHOLD) {
        circuitBreakerOpen = true;
        console.log('⚠️ Circuit breaker opened due to failures');
    }
}

function recordSuccess() {
    if (failureCount > 0) {
        failureCount = Math.max(0, failureCount - 1);
    }
}

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


const getTrackingData = async (resi: string, courier: string) => {
    const redisKey = `${instanceId}:getTrackingData:${courier}:${resi}`;

    // ✅ Try fetching from Redis cache
    const cached = await redis.get(redisKey);
    if (cached) {
        return JSON.parse(cached);
    }

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

    const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
    const page = await browser.newPage();
    await page.setUserAgent(randomUserAgent);

    const url = `https://cekresi.com/?v=wi1&noresi=${resi}`;
    await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
    });

    await page.waitForSelector('#cekresi', { visible: true });
    await page.click('#cekresi');

    const courierSelector = `a[onclick="setExp('${courier}');doCheckR()"]`;
    await page.waitForSelector(courierSelector, { timeout: 15000 });
    await page.click(courierSelector);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForSelector('a.accordion-toggle[href="#collapseTwo"]', { timeout: 15000 });
    await page.click('a.accordion-toggle[href="#collapseTwo"]');

    const rows = await page.$$eval('table.table tbody tr', trs =>
        trs
            .map(tr => {
                const cells = tr.querySelectorAll('td');
                if (cells.length === 2) {
                    return {
                        date: cells[0]?.textContent?.trim() ?? '',
                        status: cells[1]?.textContent?.trim() ?? '',
                    };
                }
                return null;
            })
            .filter(Boolean)
    );

    await browser.close();

    // 💾 Cache to Redis (TTL = 5 minutes)
    await redis.set(redisKey, JSON.stringify(rows), 'EX', 300);

    return rows;
};



// Middleware for rate limiting and load balancing
app.use((req, res, next) => {
    if (currentRequests >= MAX_CONCURRENT_REQUESTS) {
        return res.status(503).json({
            error: 'Service temporarily unavailable - too many requests',
            retryAfter: 5
        });
    }

    if (isCircuitBreakerOpen()) {
        return res.status(503).json({
            error: 'Service temporarily unavailable - circuit breaker open',
            retryAfter: 60
        });
    }

    currentRequests++;
    res.on('finish', () => {
        currentRequests--;
    });

    next();
});

// Health check endpoint with detailed metrics
app.get('/health', (req: express.Request, res: express.Response) => {
    const isHealthy = !isCircuitBreakerOpen() && currentRequests < MAX_CONCURRENT_REQUESTS;

    res.status(isHealthy ? 200 : 503).json({
        status: isHealthy ? 'UP' : 'DOWN',
        timestamp: new Date().toISOString(),
        service: EUREKA_APP_NAME,
        instanceId,
        metrics: {
            currentRequests,
            maxConcurrentRequests: MAX_CONCURRENT_REQUESTS,
            failureCount,
            circuitBreakerOpen,
            processId: process.pid,
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage(),
        },
    });
});

// Info endpoint with scaling information
app.get('/info', (req: express.Request, res: express.Response) => {
    res.json({
        app: {
            name: EUREKA_APP_NAME,
            description: 'Scalable tracking service for package delivery',
            version: '1.0.0',
            instanceId,
        },
        system: {
            hostname: EUREKA_INSTANCE_HOST,
            ip: EUREKA_INSTANCE_IP,
            port: EUREKA_INSTANCE_PORT,
            processId: process.pid,
            numWorkers: NUM_WORKERS,
        },
        scaling: {
            maxConcurrentRequests: MAX_CONCURRENT_REQUESTS,
            currentRequests,
            circuitBreakerThreshold: CIRCUIT_BREAKER_THRESHOLD,
            requestTimeout: REQUEST_TIMEOUT,
        },
    });
});

// Metrics endpoint for monitoring
app.get('/metrics', (req: express.Request, res: express.Response) => {
    res.json({
        timestamp: new Date().toISOString(),
        instanceId,
        metrics: {
            requests: {
                current: currentRequests,
                max: MAX_CONCURRENT_REQUESTS,
            },
            circuitBreaker: {
                open: circuitBreakerOpen,
                failures: failureCount,
                threshold: CIRCUIT_BREAKER_THRESHOLD,
                lastFailure: lastFailureTime ? new Date(lastFailureTime).toISOString() : null,
            },
            system: {
                uptime: process.uptime(),
                memoryUsage: process.memoryUsage(),
                cpuUsage: process.cpuUsage(),
            },
        },
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
        recordSuccess();

        res.json({
            resi,
            courier,
            result,
            instanceId,
            processingTime: Date.now() - startTime
        });
    } catch (err) {
        recordFailure();
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
    eurekaClient.stop(() => {
        console.log('📤 Deregistered from Eureka');
        process.exit(0);
    });

    // Force exit if graceful shutdown takes too long
    setTimeout(() => {
        console.log('⚠️ Forced shutdown');
        process.exit(1);
    }, 10000);
};

// Handle shutdown signals
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

function startServer() {
    app.listen(EUREKA_INSTANCE_PORT, () => {
        console.log(`✅ Server running at http://localhost:${EUREKA_INSTANCE_PORT}`);
        console.log(`🆔 Instance ID: ${instanceId}`);
        console.log(`🏠 Hostname: ${EUREKA_INSTANCE_HOST}`);
        console.log(`🌐 IP Address: ${EUREKA_INSTANCE_IP}`);
        console.log(`📋 Service Name: ${EUREKA_APP_NAME}`);
        console.log(`🔍 Eureka Server: http://${EUREKA_SERVER_HOST}:${EUREKA_SERVER_PORT}`);
        console.log(`⚡ Max Concurrent Requests: ${MAX_CONCURRENT_REQUESTS}`);
        console.log(`🔄 Circuit Breaker Threshold: ${CIRCUIT_BREAKER_THRESHOLD}`);

        // Start Eureka client
        eurekaClient.start((error) => {
            if (error) {
                console.error('❌ Failed to register with Eureka:', error.message);
            } else {
                console.log('🎯 Successfully registered with Eureka!');
            }
        });
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