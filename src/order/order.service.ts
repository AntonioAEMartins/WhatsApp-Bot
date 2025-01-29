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

    async updateOrder(id: string, updateData: Partial<BaseOrderDTO>): Promise<SimpleResponseDto<BaseOrderDTO>> {
        const order = await this.db.collection("orders").findOne({ _id: new ObjectId(id) });

        if (!order) {
            throw new HttpException("Order not found", HttpStatus.NOT_FOUND);
        }

        const updateFields: Partial<BaseOrderDTO> = {
            ...updateData,
            updatedAt: new Date(),
        };

        await this.db.collection("orders").updateOne(
            { _id: new ObjectId(id) },
            { $set: updateFields }
        );

        return {
            msg: "Order updated",
            data: { ...order, ...updateFields } as BaseOrderDTO,
        };
    }

    /**
 * Atualiza o valor pago por um participante da mesa e verifica se a conta foi totalmente quitada.
 *
 * - Se NÃO houver divisão de conta (splitInfo), considera a conta paga se a soma total paga >= totalAmount.
 * - Se HOUVER divisão de conta (splitInfo), considera a conta paga apenas se
 *   TODOS os participantes pagaram ao menos o valor esperado (expectedAmount).
 * - Valores excedentes de um participante não compensam falta de pagamento de outro.
 *   Podem ser tratados como gorjeta (tip), se desejado.
 */
    async updateAmountPaidAndCheckOrderStatus(
        id: string,
        amountPaid: number,
        phoneNumber: string
    ): Promise<SimpleResponseDto<{ isPaid: boolean }>> {
        const order = await this.db.collection("orders").findOne({ _id: new ObjectId(id) });

        if (!order) {
            throw new HttpException("Order not found", HttpStatus.NOT_FOUND);
        }

        const orderData = order as BaseOrderDTO;

        const newAmountPaidSoFar = (orderData.amountPaidSoFar || 0) + amountPaid;


        const updateFields: Partial<BaseOrderDTO> = {
            amountPaidSoFar: newAmountPaidSoFar,
            updatedAt: new Date(),
        };

        let isPaid = false;

        let updatedContacts = orderData.splitInfo?.participants || [];

        if (orderData.splitInfo && orderData.splitInfo.participants) {
            updatedContacts = orderData.splitInfo.participants.map((contact) => {
                if (contact.phone === phoneNumber) {
                    return {
                        ...contact,
                        paidAmount: (contact.paidAmount || 0) + amountPaid,
                    };
                }
                return contact;
            });

            updateFields.splitInfo = {
                ...orderData.splitInfo,
                participants: updatedContacts,
            };
        }

        if (!orderData.splitInfo || !orderData.splitInfo.participants?.length) {
            if (newAmountPaidSoFar >= orderData.totalAmount) {
                isPaid = true;
            }
        } else {
            const allParticipantsPaidMinimum = updatedContacts.every(
                (participant) => (participant.paidAmount || 0) >= participant.expectedAmount
            );

            if (allParticipantsPaidMinimum) {
                isPaid = true;
            }
        }


        await this.db.collection("orders").updateOne(
            { _id: new ObjectId(id) },
            { $set: updateFields }
        );

        return {
            msg: "Order updated",
            data: { isPaid },
        };
    }


}