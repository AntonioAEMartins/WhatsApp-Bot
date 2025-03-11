import { Logger } from '@nestjs/common';
import * as dotenv from 'dotenv';

// Load .env file before initializing the app
dotenv.config();

const logger = new Logger('Configuration');

export function printConfig(): void {
    logger.log('=================================');
    logger.log(`🚀 Environment: ${process.env.ENVIRONMENT}`);
    if (process.env.ENVIRONMENT === 'sandbox') {
        logger.log(`Running on Port: ${process.env.SANDBOX_PORT}`);
    }
    logger.log('=================================');

    // PoS Backend URL
    let posBackendUrl = "⚠️ Undefined Environment";
    switch (process.env.ENVIRONMENT) {
        case 'development':
            posBackendUrl = process.env.POS_DEV_BACKEND_URL;
            break;
        case 'homologation':
            posBackendUrl = process.env.POS_HOM_BACKEND_URL;
            break;
        case 'production':
            posBackendUrl = process.env.POS_PROD_BACKEND_URL;
            break;
        case 'sandbox':
            posBackendUrl = process.env.POS_SANDBOX_BACKEND_URL;
            break;
    }
    logger.log(`🔗 PoS Backend URL: ${posBackendUrl}`);

    // Cloud Service URL
    let cloudServiceUrl = "⚠️ Undefined Environment";
    switch (process.env.ENVIRONMENT) {
        case 'development':
            cloudServiceUrl = process.env.CS_DEV_BACKEND_URL;
            break;
        case 'homologation':
            cloudServiceUrl = process.env.CS_HOM_BACKEND_URL;
            break;
        case 'production':
            cloudServiceUrl = process.env.CS_PROD_BACKEND_URL;
            break;
        case 'sandbox':
            cloudServiceUrl = process.env.CS_SANDBOX_BACKEND_URL;
            break;
    }
    logger.log(`🌐 Cloud Service URL: ${cloudServiceUrl}`);

    // iPag URL
    let iPagUrl = "⚠️ Undefined Environment";
    switch (process.env.ENVIRONMENT) {
        case 'development':
            iPagUrl = process.env.IPAG_BASE_DEV_URL;
            break;
        case 'homologation':
            iPagUrl = process.env.IPAG_BASE_DEV_URL;
            break;
        case 'production':
            iPagUrl = process.env.IPAG_BASE_PROD_URL;
            break;
        case 'sandbox':
            iPagUrl = process.env.IPAG_BASE_SANDBOX_URL;
            break;
    }
    logger.log(`💳 iPag URL: ${iPagUrl}`);

    // MongoDB Configuration
    logger.log('=================================');
    logger.log('📦 MongoDB Configuration:');
    if (process.env.ENVIRONMENT === 'development') {
        logger.log(`  Host: ${process.env.MONGO_DEV_HOST}`);
        logger.log(`  Port: ${process.env.MONGO_DEV_PORT}`);
        logger.log(`  DB: ${process.env.MONGO_DEV_DB}`);
    } else if (process.env.ENVIRONMENT === 'homologation') {
        logger.log(`  DB (Running Locally with PoS): ${process.env.MONGO_HOM_DB}`);
    } else if (process.env.ENVIRONMENT === 'production') {
        logger.log(`  Host: ${process.env.MONGO_PROD_HOST}`);
        logger.log(`  Port: ${process.env.MONGO_PROD_PORT}`);
        logger.log(`  DB: ${process.env.MONGO_PROD_DB}`);
    } else if (process.env.ENVIRONMENT === 'sandbox') {
        logger.log(`  DB (Running Locally with PoS): ${process.env.MONGO_SANDBOX_DB}`);
    } else {
        logger.warn("⚠️ Undefined Environment");
    }
    logger.log('=================================');
}
