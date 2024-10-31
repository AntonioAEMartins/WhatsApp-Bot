import { Test, TestingModule } from '@nestjs/testing';
import { WhatsAppService } from './whatsapp.service';
import { Client } from 'whatsapp-web.js';

jest.mock('whatsapp-web.js', () => {
  return {
    Client: jest.fn().mockImplementation(() => ({
      on: jest.fn(),
      initialize: jest.fn(),
      sendMessage: jest.fn(),
    })),
    LocalAuth: jest.fn(),
  };
});

describe('WhatsAppService', () => {
  let service: WhatsAppService;
  let client: Client;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [WhatsAppService],
    }).compile();

    service = module.get<WhatsAppService>(WhatsAppService);
    client = service['client'];
  });

  describe('handleProcessingOrder', () => {
    it('should send order details and set the step to confirm_order', async () => {
      const from = 'user-id';
      const state = { step: 'processing_order' };

      const sentMessages = await service['handleProcessingOrder'](from, state);

      expect(sentMessages).toEqual([
        '(🍽️) Prato 1\n1 un. x R$ 50,00 = R$ 50,00\n\n(🍽️) Prato 2\n2 un. x R$ 30,00 = R$ 60,00\n\n-----------------------------------\n\n✨ Taxa de Serviço: R$ 11,00\n💳 Total Bruto: R$ 121,00',
        '👍 A sua comanda está correta?\n\n1- Sim\n2- Não',
      ]);
      expect(state.step).toBe('confirm_order');
    });
  });

  describe('handleConfirmOrder', () => {
    it('should proceed to split bill if order is confirmed', async () => {
      const from = 'user-id';
      const state = { step: 'confirm_order' };

      const sentMessages = await service['handleConfirmOrder'](from, '1', state);

      expect(sentMessages).toEqual([
        '👍 Você gostaria de dividir a conta?\n\n1- Sim, em partes iguais\n2- Não',
      ]);
      expect(state.step).toBe('split_bill');
    });

    it('should end conversation if order is rejected', async () => {
      const from = 'user-id';
      const state = { step: 'confirm_order' };

      const sentMessages = await service['handleConfirmOrder'](from, '2', state);

      expect(sentMessages).toEqual([
        'Que pena! Lamentamos pelo ocorrido e o atendente responsável irá conversar com você.',
      ]);
      expect(service['clientStates'].get(from)).toBeUndefined();
    });

    it('should ask again if input is not valid', async () => {
      const from = 'user-id';
      const state = { step: 'confirm_order' };

      const sentMessages = await service['handleConfirmOrder'](from, 'invalid-input', state);

      expect(sentMessages).toEqual([
        'Por favor, responda com 1 para Sim ou 2 para Não.',
      ]);
      expect(state.step).toBe('confirm_order');
    });
  });

  describe('handleSplitBill', () => {
    it('should ask for number of people if split is confirmed', async () => {
      const from = 'user-id';
      const state = { step: 'split_bill' };

      const sentMessages = await service['handleSplitBill'](from, '1', state);

      expect(sentMessages).toEqual([
        'Ok, gostaria de dividir entre quantas pessoas?\n\nLembrando que apenas suportamos a divisão em partes iguais.',
      ]);
      expect(state.step).toBe('split_bill_number');
    });

    it('should ask for a tip if split is rejected', async () => {
      const from = 'user-id';
      const state = { step: 'split_bill' };

      const sentMessages = await service['handleSplitBill'](from, '2', state);

      expect(sentMessages).toEqual([
        'Você foi bem atendido? Que tal dar uma gorjetinha extra? 😊💸\n\n- 3%\n- *5%* (Escolha das últimas mesas 🔥)\n- 7%',
      ]);
      expect(state.step).toBe('extra_tip');
    });
  });

  describe('handleWaitingForContacts', () => {
    it('should notify others and calculate individual amounts', async () => {
      const from = 'user-id';
      const state = { step: 'waiting_for_contacts', numPeople: 3 };

      const sentMessages = await service['handleWaitingForContacts'](from, state);

      expect(sentMessages).toEqual([
        '👋 *Coti Pagamentos* - Boa noite! Você foi solicitado para dividir a conta no Cris Parrila.',
        'Sua parte ficou: *R$ 40.33*',
        'Recebido!',
      ]);
      expect(service['clientStates'].get(from)).toBeUndefined();
    });
  });

  describe('handleExtraTip', () => {
    it('should proceed to payment if no tip is selected', async () => {
      const from = 'user-id';
      const state = { step: 'extra_tip' };

      const sentMessages = await service['handleExtraTip'](from, 'não', state);

      expect(sentMessages).toEqual([
        'Sem problemas!',
        'O valor final da sua conta foi de: *R$ VALOR_FINAL*',
        'Segue abaixo chave copia e cola do PIX 👇\n\n00020101021126480014br.gov.bcb.pix0126emporiocristovao@gmail.com5204000053039865802BR5917Emporio Cristovao6009SAO PAULO622905251H4NXKD6ATTA8Z90GR569SZ776304CE19',
        'Por favor, envie o comprovante! 📄✅',
      ]);
      expect(state.step).toBe('waiting_for_payment');
    });

    it('should proceed to payment with the correct tip percentage', async () => {
      const from = 'user-id';
      const state = { step: 'extra_tip' };

      const sentMessages = await service['handleExtraTip'](from, '5%', state);

      expect(sentMessages).toEqual([
        'Obrigado! 😊 \nVocê escolheu 5%, a mesma opção da maioria das últimas mesas. Sua contribuição faz a diferença para a equipe! 💪',
        'O valor final da sua conta foi de: *R$ VALOR_FINAL*',
        'Segue abaixo chave copia e cola do PIX 👇\n\n00020101021126480014br.gov.bcb.pix0126emporiocristovao@gmail.com5204000053039865802BR5917Emporio Cristovao6009SAO PAULO622905251H4NXKD6ATTA8Z90GR569SZ776304CE19',
        'Por favor, envie o comprovante! 📄✅',
      ]);
      expect(state.step).toBe('waiting_for_payment');
    });
  });

  describe('handleWaitingForPayment', () => {
    it('should confirm payment if comprovante is received', async () => {
      const from = 'user-id';
      const state = { step: 'waiting_for_payment' };
      const message = { hasMedia: true } as any; // Mock message with media

      const sentMessages = await service['handleWaitingForPayment'](from, 'comprovante', state, message);

      expect(sentMessages).toEqual([
        'Pagamento confirmado.',
        'Muito obrigado por utilizar a *Coti* e realizar pagamentos mais *rápidos* 🙏',
        'Esperamos que sua experiência tenha sido excelente. Sua satisfação é muito importante para nós e estamos sempre prontos para te atender novamente! 😊',
        'Sua opinião é essencial para nós! Queremos saber:\n\nEm uma escala de 0 a 10, o quanto você recomendaria a Coti para amigos ou colegas?\n(0 = nada provável e 10 = muito provável)',
      ]);
      expect(state.step).toBe('feedback');
    });

    it('should send reminder after 5 minutes without payment', async () => {
      const from = 'user-id';
      const state = { step: 'waiting_for_payment', paymentStartTime: Date.now() - 6 * 60 * 1000 };

      const sentMessages = await service['handleWaitingForPayment'](from, 'waiting', state, {} as any);

      expect(sentMessages).toEqual([
        'Notamos que ainda não recebemos seu comprovante. Se precisar de ajuda ou tiver algum problema, estamos aqui para ajudar! 👍',
      ]);
      expect(state.step).toBe('payment_reminder');
    });
  });

  describe('handleFeedback', () => {
    it('should collect feedback score and prompt for detailed feedback if below 10', async () => {
      const from = 'user-id';
      const state = { step: 'feedback' };

      const sentMessages = await service['handleFeedback'](from, '8', state);

      expect(sentMessages).toEqual([
        'Agradecemos muito pelo Feedback, e queremos sempre melhorar, o que você sente que faltou para o 10?',
      ]);
      expect(state.step).toBe('feedback_detail');
    });

    it('should thank the user if feedback score is 10', async () => {
      const from = 'user-id';
      const state = { step: 'feedback' };

      const sentMessages = await service['handleFeedback'](from, '10', state);

      expect(sentMessages).toEqual([
        'Muito obrigado pelo seu feedback! 😊',
      ]);
      expect(service['clientStates'].get(from)).toBeUndefined();
    });
  });
});
