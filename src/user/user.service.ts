import { HttpException, Inject, Injectable } from '@nestjs/common';
import { Db, MongoClient, ObjectId } from 'mongodb';
import { ClientProvider } from 'src/db/db.module';
import { CreateUserDto, UserDto } from './dto/user.dto';
import { SimpleResponseDto, ListResponseDto } from 'src/request/request.dto';

@Injectable()
export class UserService {

    private readonly mongoClient: MongoClient;
    constructor(@Inject('DATABASE_CONNECTION') private db: Db, clientProvider: ClientProvider) {
        this.mongoClient = clientProvider.getClient();
    }

    async listUsers(page: number = 1): Promise<ListResponseDto<UserDto>> {
        if (page < 1) {
            throw new HttpException("Invalid page number", 400);
        } else if (!Number.isInteger(page)) {
            page = 1;
        }

        let agg: any[] = []

        agg.push({
            $sort: {
                updatedAt: -1
            }
        });

        agg.push({
            $project: {
                _id: 0
            }
        });

        agg.push({
            $group: {
                _id: null,
                count: { $sum: 1 },
                documents: { $push: '$$ROOT' }
            }
        });
        agg.push({
            $project: {
                count: 1,
                data: { $slice: ['$documents', (page - 1) * 10, 10] }
            }
        });

        const users = await this.db.collection("users").aggregate(agg).toArray();

        if (!users[0]) {
            return {
                msg: "No users found",
                data: [],
                count: 0
            }
        }

        return {
            msg: "Users found",
            data: users[0].data,
            count: users[0].count
        }
    }

    async getUser(userId: string): Promise<SimpleResponseDto<UserDto>> {
        const user = await this.db.collection<UserDto>("users").findOne(
            { userId: userId },
            { projection: { _id: 0 } }
        );

        if (!user) {
            throw new HttpException("User not found", 404);
        }

        return {
            msg: "User found",
            data: user,
        };
    }

    async createUser(createUser: CreateUserDto): Promise<SimpleResponseDto<UserDto>> {

        const userExists = await this.db.collection("users").findOne({ userId: createUser.userId });

        if (userExists) {
            throw new HttpException("User already exists", 400);
        }

        const userData = {
            ...createUser,
            createdAt: new Date(),
            updatedAt: new Date()
        }

        await this.db.collection("users").insertOne(userData)

        return {
            msg: "User created",
            data: createUser
        }
    }

    async updateUserName(userId: string, userName: string): Promise<SimpleResponseDto<UserDto>> {
        const user = await this.db.collection("users").findOneAndUpdate(
            { userId: userId },
            { $set: { userName: userName } },
            { returnDocument: "after" }
        );

        return {
            msg: "User name updated",
            data: user.value as UserDto
        }
    }

}
