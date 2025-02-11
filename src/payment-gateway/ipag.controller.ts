import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Param, Post } from '@nestjs/common';
import { IPagService } from './ipag.service';
import { CardInfoDto, CreatePaymentDto, PaymentMethodCard, PaymentType, UserPaymentInfoDto } from './dto/ipag-pagamentos.dto';
import { IsNotEmpty, IsString, validate } from 'class-validator';
import { CreateEstablishmentDto, CreateSellerDto } from './dto/ipag-marketplace.dto';
import { CreateCheckoutDto } from './dto/ipag-checkout.dto';

@Controller('ipag')
export class IPagController {
  constructor(private readonly ipagService: IPagService) { }

  @Post('create-payment')
  @HttpCode(200)
  async createPayment(@Body() userPaymentInfo: UserPaymentInfoDto, @Body() transactionId: string) {
    const response = await this.ipagService.createPayment(userPaymentInfo, transactionId);
    return response;
  }

  @Post("payment/checkout/credit-card")
  @HttpCode(200)
  async createCheckoutCreditCard() {

    const createCheckout: CreateCheckoutDto = {
      customer: {
        name: 'Antônio Martins',
        tax_receipt: '478.835.168-41',
      },
      order: {
        order_id: '12345432',
        amount: 10.50,
      },
      split_rules: [
        {
          receiver: 'bd0181690d928c05350f75ce49aecb2a',
          percentage: 50,
          charge_processing_fee: true,
        }
      ]
    }

    const validation = await validate(createCheckout);
    if (validation.length > 0) {
      throw new HttpException(validation, HttpStatus.BAD_REQUEST);
    }

    const response = await this.ipagService.createCheckout(createCheckout);
    return response;
  }

  @Post('callback')
  @HttpCode(200)
  async handleCallback(@Body() callbackData: any) {
    try {
      // console.log('[handleCallback] callbackData', callbackData);
      const response = await this.ipagService.processCallback(callbackData);
      return callbackData;
    } catch (error) {
      console.error('Error handling callback:', error);
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @Get('list-account-fees')
  @HttpCode(200)
  async listAccountFees() {
    const response = await this.ipagService.listAccountFees();
    console.log(response);
    return response;
  }

  @Post('/marketplace/seller')
  @HttpCode(200)
  async createSeller() {

    const createSeller: CreateSellerDto = {
      login: 'josefrancisco23423',
      password: '123123',
      name: 'José Francisco Silva',
      cpf_cnpj: '47883516841',
      email: 'teste@icloud.com',
      phone: '(11) 9133-9876',
    }

    const validation = await validate(createSeller);
    if (validation.length > 0) {
      throw new HttpException(validation, HttpStatus.BAD_REQUEST);
    }

    const response = await this.ipagService.createSeller(createSeller);
    return response;
  }

  @Post('/marketplace/establishment')
  @HttpCode(200)
  async createEstablishment() {
    const createEstablishment: CreateEstablishmentDto = {
      name: 'José Francisco Silva',
      email: 'antonioaem@icloud.com',
      login: 'antoniojosefrancisco123',
      password: '123123',
      document: '854.508.440-42',
      phone: '(11) 9133-9876',
      address: {
        street: "Rua das Flores",
        number: "123",
        complement: "Apto 123",
        district: "Bairro das Flores",
        city: "São Paulo",
        state: "SP",
        zipcode: "1234567890",
      },
      owner: {
        name: "Giosepe",
        email: "giosepe@teste.com",
        cpf: "799.993.388-01",
        phone: "(11) 91363-9876",
      },
      bank: {
        code: "290",
        agency: "0001",
        account: "100500",
        type: "checkings",
        external_id: "teste@mail.me",
      },
    }

    const response = await this.ipagService.createEstablishment(createEstablishment);
    return response;
  }

  @Post(`card/get-method`)
  @HttpCode(200)
  async getCardMethod(@Body() cardInfo: CardInfoDto) {
    const response = await this.ipagService.getCardMethod(cardInfo.number);
    return response;
  }
}
