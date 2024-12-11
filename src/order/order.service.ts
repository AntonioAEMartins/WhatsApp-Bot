import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { MongoClient, Db, WithId, ObjectId } from 'mongodb';
import { ClientProvider } from 'src/db/db.module';
import { SimpleResponseDto } from 'src/request/request.dto';
import { BaseOrderDTO, CreateOrderDTO } from './dto/order.dto';
@Injectable()
export class OrderService {

    private readonly mongoClient: MongoClient;
    private readonly timeThreshold = 2 * 60 * 60 * 1000; // 2 hours in milliseconds
    constructor(@Inject('DATABASE_CONNECTION') private db: Db, clientProvider: ClientProvider) {
        this.mongoClient = clientProvider.getClient();
    }

    async createOrder(createOrderData: CreateOrderDTO): Promise<SimpleResponseDto<CreateOrderDTO>> {
        const orderData: CreateOrderDTO = {
            _id: new ObjectId(),
            ...createOrderData,
            createdAt: new Date(),
        }

        const order = await this.db.collection("orders").insertOne(orderData);

        return {
            msg: "Order created",
            data: orderData
        }
    }

    async getOrder(id: string): Promise<SimpleResponseDto<BaseOrderDTO>> {
        const order = await this.db.collection("orders").findOne(
            { _id: new ObjectId(id) },
            {
                sort: { createdAt: -1 },
            },
        );

        if (!order) {
            throw new HttpException("Order not found", HttpStatus.NOT_FOUND);
        }

        return {
            msg: "Order found",
            data: order as BaseOrderDTO,
        }
    }

}