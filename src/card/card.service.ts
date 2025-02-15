import { Injectable, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { Db, ObjectId } from 'mongodb';
import { BaseCardDto, CardDto } from './dto/card.dto';
import { ClientProvider } from 'src/db/db.module';
import { SimpleResponseDto } from 'src/request/request.dto';
@Injectable()
export class CardService {

    constructor(
        @Inject('DATABASE_CONNECTION') private db: Db, clientProvider: ClientProvider,
    ) { }

    async createCard(card: BaseCardDto): Promise<SimpleResponseDto<{ _id: string }>> {
        const newCard = { _id: new ObjectId(), ...card };

        await this.db.collection("cards").insertOne(newCard);

        return {
            msg: "Card created",
            data: {
                _id: newCard._id.toString(),
            },
        };
    }

    async getCardsByUserId(userId: string): Promise<SimpleResponseDto<Omit<CardDto, 'token'>[]>> {
        const cards = await this.db
            .collection<CardDto>("cards")
            .find({ userId, token: { $ne: null } }, { projection: { token: 0 } })
            .toArray();

        return {
            msg: "Cards found",
            data: cards as Omit<CardDto, 'token'>[],
        };
    }

    async getCardById(cardId: string): Promise<SimpleResponseDto<{ token: string, holderName: string, holderDocument: string }>> {
        const cardToken = await this.db.collection("cards").findOne({ _id: new ObjectId(cardId) }, { projection: { token: 1, holder: 1 } });

        if (!cardToken) {
            throw new HttpException('Token not found', HttpStatus.NOT_FOUND);
        }

        return {
            msg: "Token found",
            data: {
                token: cardToken.token,
                holderName: cardToken.holder.name,
                holderDocument: cardToken.holder.document,
            },
        };
    }
}
