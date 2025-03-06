// src/payment-gateway/ipag.service.spec.ts
import { IPagService } from './ipag.service';
import { CreatePaymentDto, PaymentMethodCard, PaymentType } from './dto/ipag-pagamentos.dto';
import { IPagTransactionResponse } from './types/ipag-response.types';

jest.mock('node-fetch', () => jest.fn());
import fetch from 'node-fetch';
const { Response } = jest.requireActual('node-fetch');

describe('IPagService', () => {
  let service: IPagService;

  beforeEach(() => {
    process.env.IPAG_API_ID = 'testApiId';
    process.env.IPAG_API_KEY = 'testApiKey';
    process.env.IPAG_BASE_DEV_URL = 'https://dev.api.ipag.com.br';
    process.env.IPAG_BASE_PROD_URL = 'https://prod.api.ipag.com.br';
    service = new IPagService();
  });

  it('should create a payment successfully', async () => {
    const mockResponse: IPagTransactionResponse = {
      // mock the expected response structure
    };
    (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce(new Response(JSON.stringify(mockResponse)));

    const paymentData: CreatePaymentDto = {
      amount: 100,
      callback_url: 'https://example.com/callback',
      payment: {
        type: PaymentType.card,
        method: PaymentMethodCard.visa,
        installments: 1,
        capture: true,
        fraud_analysis: true,
        recurring: false,
        card: {
          holder: 'John Doe',
          number: '4111 1111 1111 1111',
          expiry_month: '01',
          expiry_year: '2025',
          cvv: '123',
          token: null,
          tokenize: false,
        },
        softdescriptor: 'Teste de pagamento'
      },
      customer: {
        name: 'John Doe',
        cpf_cnpj: '1234567890123456',
      }
    };

    const response = await service.createPayment(paymentData);
    expect(response).toEqual(mockResponse);
  });

  it('should throw an error if the payment creation fails', async () => {
    (fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce(new Response(null, { status: 500 }));

    const paymentData: CreatePaymentDto = {
      // same as above
    };

    await expect(service.createPayment(paymentData)).rejects.toThrow('HTTP Error: 500');
  });
});