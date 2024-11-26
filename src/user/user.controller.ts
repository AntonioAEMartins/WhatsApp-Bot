import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { UserService } from './user.service';
import { CreateUserDto } from './dto/user.dto';

@Controller('user')
export class UserController {
    constructor(private readonly userService: UserService) { }

    @Get()
    async listUsers(@Param("page") page: number) {
        return await this.userService.listUsers(page);
    }

    @Get(":id")
    async getUser(@Param("id") id: string) {
        return await this.userService.getUser(id);
    }

    @Post()
    async createUser(@Body() createUser: CreateUserDto) {
        return await this.userService.createUser(createUser);
    }

    
}
