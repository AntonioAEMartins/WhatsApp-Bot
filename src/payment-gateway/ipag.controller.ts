import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { IPagService } from './ipag.service';
import { CardInfoDto, UserPaymentCreditInfoDto, UserPaymentPixInfoDto } from './dto/ipag-pagamentos.dto';
import { validate } from 'class-validator';
import { CreateEstablishmentDto, CreateSellerDto } from './dto/ipag-marketplace.dto';

@Controller('ipag')
export class IPagController {
  constructor(private readonly ipagService: IPagService) { }

  @Post('payment/credit-card')
  @HttpCode(200)
  async createCreditCardPayment(@Body() userPaymentInfo: UserPaymentCreditInfoDto) {

    if (userPaymentInfo.cardInfo.expiry_year.length === 2) {
      userPaymentInfo.cardInfo.expiry_year = `20${userPaymentInfo.cardInfo.expiry_year}`;
    }

    const response = await this.ipagService.createCreditCardPayment(userPaymentInfo);
    return response;
  }

  @Post('payment/pix')
  @HttpCode(200)
  async createPIXPayment(@Body() userPaymentInfo: UserPaymentPixInfoDto) {
    const response = await this.ipagService.createPIXPayment(userPaymentInfo);
    return response;
  }

  /**
   * Endpoint para receber callbacks do iPag.
   *
   * Para que a validação da assinatura funcione corretamente, é necessário:
   * - Obter o corpo bruto (rawBody) da requisição (deve ser configurado via middleware).
   * - Obter os headers obrigatórios (X-Ipag-Signature, X-Ipag-Event e X-Ipag-Timestamps).
   * - Obter o IP de origem da requisição.
   *
   * Em caso de callback válido, retorna um status 200; caso contrário, lança exceção.
   */
  @Post('callback')
  @HttpCode(200)
  async handleCallback(
    @Body() callbackData: any,
    @Req() req: Request,
  ): Promise<any> {
    try {
      console.log("Salve")
      // Supondo que o rawBody tenha sido armazenado via middleware customizado
      const rawBody: string = req['rawBody'];
      const headers = req.headers;
      const ipAddress = headers["cf-connecting-ip"];

      const response = await this.ipagService.processCallback(callbackData, rawBody, headers, ipAddress);
      return response;
    } catch (error) {
      console.error('Error handling callback:', error);
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
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
  @Post('/simulate-transaction-completion/:transactionId')
  @HttpCode(200)
  async simulateTransactionCompletion(@Param('transactionId') transactionId: string) {
    const response = await this.ipagService.simulateTransactionCompletion(transactionId);
    return response;
  }
}
