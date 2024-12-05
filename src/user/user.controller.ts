import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { UserService } from './user.service';
import { CreateUserDto } from './dto/user.dto';

@Controller('user')
export class UserController {
    constructor(private readonly userService: UserService) { }

    @HttpCode(HttpStatus.OK)
    @Get()
    async listUsers(@Param("page") page: number) {
        return await this.userService.listUsers(page);
    }

    @HttpCode(HttpStatus.OK)
    @Get(":id")
    async getUser(@Param("id") id: string) {
        return await this.userService.getUser(id);
    }

    @HttpCode(HttpStatus.CREATED)
    @Post()
    async createUser(@Body() createUser: CreateUserDto) {
        return await this.userService.createUser(createUser);
    }

    
}
