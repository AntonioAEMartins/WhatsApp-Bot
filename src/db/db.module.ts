import { Module, Injectable } from '@nestjs/common';
import { MongoClient, Db } from 'mongodb';

@Injectable()
export class ClientProvider {
    client: MongoClient | null
    getClient(): MongoClient {
        if (this.client == null) {
            const mongoHost = process.env.LOCAL === 'true' ? process.env.MONGO_HOST_LOCAL : process.env.MONGO_HOST_NETWORK;
            this.client = new MongoClient(`mongodb://${process.env.MONGO_USER}:${process.env.MONGO_PASS}@${mongoHost}:${process.env.MONGO_PORT}/`);
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
                    const dbName = process.env.MONGO_DB_NAME;
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