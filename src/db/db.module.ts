import { Module, Injectable } from '@nestjs/common';
import { MongoClient, Db } from 'mongodb';

@Injectable()
export class ClientProvider {
    client: MongoClient | null
    getClient(): MongoClient {
        if (this.client == null) {
            // If the environment is homologation, production or sandbox, the code will be executed from the cloud instance that have the mongo host in the local network
            const mongoHost = process.env.ENVIRONMENT === 'homologation' || process.env.ENVIRONMENT === 'production' || process.env.ENVIRONMENT === 'sandbox' ? process.env.MONGO_PROD_HOST : process.env.MONGO_DEV_HOST;
            const mongoPort = process.env.ENVIRONMENT === 'homologation' || process.env.ENVIRONMENT === 'production' || process.env.ENVIRONMENT === 'sandbox' ? process.env.MONGO_PROD_PORT : process.env.MONGO_DEV_PORT;
            const mongoUser = process.env.ENVIRONMENT === 'homologation' || process.env.ENVIRONMENT === 'production' || process.env.ENVIRONMENT === 'sandbox' ? process.env.MONGO_PROD_USER : process.env.MONGO_DEV_USER;
            const mongoPass = process.env.ENVIRONMENT === 'homologation' || process.env.ENVIRONMENT === 'production' || process.env.ENVIRONMENT === 'sandbox' ? process.env.MONGO_PROD_PASS : process.env.MONGO_DEV_PASS;

            this.client = new MongoClient(`mongodb://${mongoUser}:${mongoPass}@${mongoHost}:${mongoPort}/`);
        }
        return this.client
    }
}

@Module({
    providers: [
        {
            provide: 'DATABASE_CONNECTION',
            useFactory: async (clientProvider: ClientProvider): Promise<Db> => {
                try {
                    const client = clientProvider.getClient()
                    let dbName;
                    
                    if (process.env.ENVIRONMENT === 'sandbox') {
                        dbName = process.env.MONGO_SANDBOX_DB;
                    } else if (process.env.ENVIRONMENT === 'homologation') {
                        dbName = process.env.MONGO_HOM_DB;
                    } else if (process.env.ENVIRONMENT === 'production') {
                        dbName = process.env.MONGO_PROD_DB;
                    } else {
                        dbName = process.env.MONGO_DEV_DB;
                    }
                    
                    return client.db(dbName)
                } catch (e) {
                    throw e;
                }
            },
            inject: [ClientProvider]
        },
        ClientProvider
    ],
    exports: ['DATABASE_CONNECTION', ClientProvider],
})
export class DatabaseModule { }