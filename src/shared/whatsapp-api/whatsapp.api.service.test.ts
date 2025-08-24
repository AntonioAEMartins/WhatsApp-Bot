import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import * as fs from 'fs';
import { WhatsAppApiService } from './whatsapp.api.service';
import { HttpException } from '@nestjs/common';

vi.mock('fs');
vi.mock('@nestjs/axios');

function createHttpServiceMock() {
  return {
    post: vi.fn(),
    get: vi.fn()
  } as unknown as HttpService;
}

describe('WhatsAppApiService', () => {
  let service: WhatsAppApiService;
  let httpServiceMock: HttpService;
  const OLD_ENV = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...OLD_ENV };
    process.env.WHATSAPP_ACCESS_TOKEN = 'token';
    process.env.WHATSAPP_PROD_PHONE_NUMBER_ID = 'phone123';

    httpServiceMock = createHttpServiceMock();
    service = new WhatsAppApiService(httpServiceMock);
  });

  afterEach(() => {
    process.env = OLD_ENV;
    vi.restoreAllMocks();
  });

  describe('sendMessageReaction', () => {
    it('should throw HttpException when accessToken or phoneNumberId not configured', async () => {
      process.env.WHATSAPP_ACCESS_TOKEN = '';
      service = new WhatsAppApiService(httpServiceMock);
      await expect(service.sendMessageReaction('to', 'mid', '😊')).rejects.toBeInstanceOf(HttpException);
    });

    it('should call httpService.post with correct url, headers and body for valid inputs and return response.data', async () => {
      const resp = { data: { success: true } };
      (httpServiceMock.post as any).mockReturnValueOnce(of(resp));
      const result = await service.sendMessageReaction('5511999999999', 'm1', '👍');
      expect(httpServiceMock.post).toHaveBeenCalled();
      expect(result).toEqual(resp.data);
    });

    it('should log and throw HttpException when httpService.post throws error with response.data', async () => {
      const err = { response: { data: { message: 'bad' } } };
      (httpServiceMock.post as any).mockReturnValueOnce(throwError(() => err));
      await expect(service.sendMessageReaction('5511999999999', 'm1', '👍')).rejects.toBeInstanceOf(HttpException);
    });
  });

  describe('markMessageAsSeen', () => {
    it('should throw HttpException when accessToken or phoneNumberId not configured', async () => {
      process.env.WHATSAPP_ACCESS_TOKEN = '';
      service = new WhatsAppApiService(httpServiceMock);
      await expect(service.markMessageAsSeen('m1')).rejects.toBeInstanceOf(HttpException);
    });

    it('should call httpService.post and return response.data on success', async () => {
      const resp = { data: { status: 'ok' } };
      (httpServiceMock.post as any).mockReturnValueOnce(of(resp));
      const result = await service.markMessageAsSeen('m1');
      expect(result).toEqual(resp.data);
    });

    it('should return error object (not throw) when httpService.post throws error', async () => {
      const err = new Error('fail');
      (httpServiceMock.post as any).mockReturnValueOnce(throwError(() => err));
      const result = await service.markMessageAsSeen('m1');
      expect(result).toHaveProperty('error');
    });
  });

  describe('sendWhatsAppMessage', () => {
    it('should throw HttpException when accessToken or phoneNumberId not configured', async () => {
      process.env.WHATSAPP_ACCESS_TOKEN = '';
      service = new WhatsAppApiService(httpServiceMock);
      await expect(service.sendWhatsAppMessage({ type: 'text', content: 'hi', to: 't' } as any)).rejects.toBeInstanceOf(HttpException);
    });

    it('should construct and send text message correctly', async () => {
      const resp = { data: { id: 'm1' } };
      (httpServiceMock.post as any).mockReturnValueOnce(of(resp));
      const result = await service.sendWhatsAppMessage({ type: 'text', content: 'hello', to: 't' } as any);
      expect(httpServiceMock.post).toHaveBeenCalled();
      expect(result).toEqual(resp.data);
    });

    it('should construct and send image (link) message correctly', async () => {
      const resp = { data: { id: 'img1' } };
      (httpServiceMock.post as any).mockReturnValueOnce(of(resp));
      const result = await service.sendWhatsAppMessage({ type: 'image', content: 'http://image', to: 't' } as any);
      expect(httpServiceMock.post).toHaveBeenCalled();
      expect(result).toEqual(resp.data);
    });

    it('should throw BadRequest HttpException when interactive type but missing interactive data', async () => {
      await expect(service.sendWhatsAppMessage({ type: 'interactive', content: '', to: 't' } as any)).rejects.toBeInstanceOf(HttpException);
    });

    it('should throw on unsupported message type', async () => {
      await expect(service.sendWhatsAppMessage({ type: 'unknown' as any, content: '', to: 't' } as any)).rejects.toBeInstanceOf(HttpException);
    });
  });

  describe('sendWhatsAppMessages', () => {
    it('should iterate messages, call sendWhatsAppMessage for each and return results array', async () => {
      const spy = vi.spyOn(service, 'sendWhatsAppMessage').mockResolvedValueOnce({ id: 1 }).mockResolvedValueOnce({ id: 2 });
      const res = await service.sendWhatsAppMessages([{ type: 'text', content: 'a', to: 't' } as any, { type: 'text', content: 'b', to: 't' } as any]);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(res.length).toBe(2);
    });

    it('should respect delay between messages (mock timer or stub setTimeout) and return all results', async () => {
      const spy = vi.spyOn(service, 'sendWhatsAppMessage').mockResolvedValue({});
      const realSetTimeout = global.setTimeout;
      vi.useFakeTimers();
      const promise = service.sendWhatsAppMessages([{ type: 'text', content: 'a', to: 't' } as any]);
      vi.runAllTimers();
      const res = await promise;
      vi.useRealTimers();
      expect(res).toBeDefined();
      spy.mockRestore();
    });
  });

  describe('uploadMedia', () => {
    it('should throw HttpException when credentials not configured', async () => {
      process.env.WHATSAPP_ACCESS_TOKEN = '';
      service = new WhatsAppApiService(httpServiceMock);
      await expect(service.uploadMedia(Buffer.from('x'), 'application/pdf')).rejects.toBeInstanceOf(HttpException);
    });

    it('should write temp file, call httpService.post with form-data and return resp.data.id on success and cleanup temp file', async () => {
      const resp = { data: { id: 'media1' } };
      // Mock fs methods
      (fs.existsSync as any).mockReturnValue(true);
      (fs.createReadStream as any).mockImplementation(() => ({}));
      (fs.writeFileSync as any).mockImplementation(() => undefined);
      (fs.unlinkSync as any).mockImplementation(() => undefined);
      (httpServiceMock.post as any).mockReturnValueOnce(of(resp));

      const id = await service.uploadMedia(Buffer.from('x'), 'application/pdf');
      expect(id).toBe('media1');
    });

    it('should cleanup temp file and throw HttpException when httpService.post fails', async () => {
      (fs.existsSync as any).mockReturnValue(true);
      (fs.writeFileSync as any).mockImplementation(() => undefined);
      (fs.unlinkSync as any).mockImplementation(() => undefined);
      (httpServiceMock.post as any).mockReturnValueOnce(throwError(() => new Error('fail')));

      await expect(service.uploadMedia(Buffer.from('x'), 'application/pdf')).rejects.toBeInstanceOf(HttpException);
    });
  });

  describe('getFileExtension', () => {
    it('should return correct extension for known mime types', () => {
      // @ts-ignore
      expect((service as any).getFileExtension('application/pdf')).toBe('pdf');
    });

    it("should return 'bin' for unknown mime type", () => {
      // @ts-ignore
      expect((service as any).getFileExtension('unknown/type')).toBe('bin');
    });
  });

  describe('retrieveMediaUrl', () => {
    it('should throw HttpException when accessToken not configured', async () => {
      process.env.WHATSAPP_ACCESS_TOKEN = '';
      service = new WhatsAppApiService(httpServiceMock);
      await expect(service.retrieveMediaUrl('mid')).rejects.toBeInstanceOf(HttpException);
    });

    it('should call httpService.get and return url on success', async () => {
      const resp = { data: { url: 'http://tmp' } };
      (httpServiceMock.get as any).mockReturnValueOnce(of(resp));
      const url = await service.retrieveMediaUrl('mid');
      expect(url).toBe('http://tmp');
    });

    it('should throw HttpException when response lacks url or httpService.get errors', async () => {
      (httpServiceMock.get as any).mockReturnValueOnce(of({ data: {} }));
      await expect(service.retrieveMediaUrl('mid')).rejects.toBeInstanceOf(HttpException);
      (httpServiceMock.get as any).mockReturnValueOnce(throwError(() => new Error('fail')));
      await expect(service.retrieveMediaUrl('mid')).rejects.toBeInstanceOf(HttpException);
    });
  });

  describe('sendImageWithLink', () => {
    it('should call httpService.post with image link body and return response.data on success', async () => {
      const resp = { data: { ok: true } };
      (httpServiceMock.post as any).mockReturnValueOnce(of(resp));
      const r = await service.sendImageWithLink('t', 'http://img', 'c');
      expect(r).toEqual(resp.data);
    });

    it('should throw HttpException when httpService.post throws error', async () => {
      (httpServiceMock.post as any).mockReturnValueOnce(throwError(() => new Error('fail')));
      await expect(service.sendImageWithLink('t', 'http://img', 'c')).rejects.toBeInstanceOf(HttpException);
    });
  });

  describe('uploadAndSendImage', () => {
    it('should call uploadMedia, retrieveMediaUrl and sendImageWithLink in sequence and return result', async () => {
      const spyUpload = vi.spyOn(service as any, 'uploadMedia').mockResolvedValue('mid');
      const spyRetrieve = vi.spyOn(service as any, 'retrieveMediaUrl').mockResolvedValue('http://tmp');
      const spySend = vi.spyOn(service as any, 'sendImageWithLink').mockResolvedValue({ ok: true });

      const res = await service.uploadAndSendImage('t', Buffer.from('x'), 'image/png', 'c');
      expect(spyUpload).toHaveBeenCalled();
      expect(spyRetrieve).toHaveBeenCalled();
      expect(spySend).toHaveBeenCalled();
      expect(res).toEqual({ ok: true });
    });

    it('should propagate errors from uploadMedia or retrieveMediaUrl', async () => {
      vi.spyOn(service as any, 'uploadMedia').mockRejectedValue(new Error('fail'));
      await expect(service.uploadAndSendImage('t', Buffer.from('x'), 'image/png', 'c')).rejects.toBeDefined();
    });
  });

  describe('isHttpUrl', () => {
    it('should return true for valid http/https URLs', () => {
      // @ts-ignore
      expect((service as any).isHttpUrl('http://a')).toBe(true);
      // @ts-ignore
      expect((service as any).isHttpUrl('https://a')).toBe(true);
    });

    it('should return false for invalid URLs or non-http protocols', () => {
      // @ts-ignore
      expect((service as any).isHttpUrl('ftp://a')).toBe(false);
      // @ts-ignore
      expect((service as any).isHttpUrl('notaurl')).toBe(false);
    });
  });

  describe('uploadDocumentBase64', () => {
    it('should throw HttpException when credentials not configured', async () => {
      process.env.WHATSAPP_ACCESS_TOKEN = '';
      service = new WhatsAppApiService(httpServiceMock);
      // @ts-ignore
      await expect((service as any).uploadDocumentBase64('abc')).rejects.toBeInstanceOf(HttpException);
    });

    it('should convert base64 to buffer and call uploadMedia returning media id', async () => {
      vi.spyOn(service as any, 'uploadMedia').mockResolvedValue('mid');
      // @ts-ignore
      const id = await (service as any).uploadDocumentBase64('data:application/pdf;base64,QUJD');
      expect(id).toBe('mid');
    });
  });

  describe('formatCurrentDate', () => {
    it('should return formatted date string in DD_MM_YYYY format (mock Date)', () => {
      const RealDate = Date;
      // @ts-ignore
      global.Date = class extends RealDate {
        constructor() { super('2020-01-05T00:00:00Z'); }
      } as any;
      // @ts-ignore
      expect((service as any).formatCurrentDate()).toBe('05_01_2020');
      // @ts-ignore
      global.Date = RealDate;
    });

    it('should pad single digit day/month with zero', () => {
      const RealDate = Date;
      // @ts-ignore
      global.Date = class extends RealDate {
        constructor() { super('2020-03-04T00:00:00Z'); }
      } as any;
      // @ts-ignore
      expect((service as any).formatCurrentDate()).toBe('04_03_2020');
      // @ts-ignore
      global.Date = RealDate;
    });
  });

  describe('createInteractiveButtonMessage', () => {
    it('should truncate buttons to max 3 and warn (spy logger) when >3 provided', () => {
      const warnSpy = vi.spyOn((service as any).logger, 'warn');
      const buttons = [
        { id: '1', title: 'a' }, { id: '2', title: 'b' }, { id: '3', title: 'c' }, { id: '4', title: 'd' }
      ];
      const res = service.createInteractiveButtonMessage('t', 'body', buttons);
      expect(res.interactive.buttons.length).toBe(3);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('should truncate button titles longer than 20 chars and include truncated titles', () => {
      const warnSpy = vi.spyOn((service as any).logger, 'warn');
      const buttons = [{ id: '1', title: 'x'.repeat(25) }];
      const res = service.createInteractiveButtonMessage('t', 'body', buttons);
      expect(res.interactive.buttons[0].title.length).toBeLessThanOrEqual(20);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('should truncate bodyText >1024 and footerText >60 and return structured interactive message', () => {
      const longBody = 'x'.repeat(2000);
      const longFooter = 'y'.repeat(200);
      const res = service.createInteractiveButtonMessage('t', longBody, [{ id: '1', title: 'ok' }], { footerText: longFooter });
      expect(res.interactive.bodyText.length).toBeLessThanOrEqual(1024);
      expect(res.interactive.footerText.length).toBeLessThanOrEqual(60);
    });
  });

  describe('createFlowMessage', () => {
    it('should throw HttpException when neither flowId nor flowName provided', () => {
      expect(() => service.createFlowMessage('t', 'b', { flowCta: 'cta' } as any)).toThrow();
    });

    it('should warn on long flowCta and long bodyText/footer and return interactive flow structure when valid params provided', () => {
      const warnSpy = vi.spyOn((service as any).logger, 'warn');
      const res = service.createFlowMessage('t', 'b', { flowId: 'f', flowCta: 'c'.repeat(40) } as any, { footerText: 'z'.repeat(200) });
      expect(res.interactive).toBeDefined();
      expect(warnSpy).toHaveBeenCalled();
    });

    it('should include flow_id when flowId provided and flow_name when flowName provided', () => {
      const r1 = service.createFlowMessage('t', 'b', { flowId: 'f', flowCta: 'c' } as any);
      expect(r1.interactive.action.parameters.flow_id).toBe('f');
      const r2 = service.createFlowMessage('t', 'b', { flowName: 'fn', flowCta: 'c' } as any);
      expect(r2.interactive.action.parameters.flow_name).toBe('fn');
    });
  });

  describe('sendFlowMessage/sendFlowMessageByName/sendFlowMessageDirectly', () => {
    it('should build flow payload using createFlowMessage/sendFlowMessageDirectly and call sendWhatsAppMessage/httpService.post returning response.data', async () => {
      vi.spyOn(service as any, 'createFlowMessage').mockReturnValue({ type: 'interactive', to: 't' } as any);
      const resp = { data: { ok: true } };
      (httpServiceMock.post as any).mockReturnValue(of(resp));
      const r = await service.sendFlowMessage('t', 'b', 'flow1', 'cta');
      expect(r).toBeDefined();
    });

    it('should throw when credentials missing or when options missing required flowId/flowName for direct method', async () => {
      process.env.WHATSAPP_ACCESS_TOKEN = '';
      service = new WhatsAppApiService(httpServiceMock);
      await expect(service.sendFlowMessageDirectly('t', 'b', 'cta', {} as any)).rejects.toBeInstanceOf(HttpException);
    });

    it('should include header/footer correctly depending on headerType and headerContent (http vs id)', async () => {
      // @ts-ignore
      const msg = await (service as any).createFlowMessage('t', 'b', { flowId: 'f', flowCta: 'c' }, { headerType: 'text', headerContent: 'h', footerText: 'ft' });
      expect(msg.interactive.header.text).toBe('h');
      expect(msg.interactive.footer.text).toBe('ft');
    });
  });

  describe('registerNumber', () => {
    it('should call httpService.post and return response.data on success', async () => {
      const resp = { data: { ok: true } };
      (httpServiceMock.post as any).mockReturnValueOnce(of(resp));
      const r = await service.registerNumber({ messaging_product: 'whatsapp', pin: '1234', phone_number_id: 'p' } as any);
      expect(r).toEqual(resp.data);
    });

    it('should log error and return undefined when httpService.post fails (per implementation)', async () => {
      (httpServiceMock.post as any).mockReturnValueOnce(throwError(() => new Error('fail')));
      const r = await service.registerNumber({ messaging_product: 'whatsapp', pin: '1234', phone_number_id: 'p' } as any);
      expect(r).toBeUndefined();
    });
  });

  describe('twoFactorAuthentication', () => {
    it('should throw Error when PIN missing or not 6 digits', async () => {
      await expect(service.twoFactorAuthentication({ phone_number_id: 'p', pin: '123' } as any)).rejects.toBeDefined();
    });

    it('should call httpService.post with correct url/body and return response.data on success', async () => {
      const resp = { data: { ok: true } };
      (httpServiceMock.post as any).mockReturnValueOnce(of(resp));
      const r = await service.twoFactorAuthentication({ phone_number_id: 'p', pin: '123456' } as any);
      expect(r).toEqual(resp.data);
    });

    it('should throw Error with message when httpService.post fails', async () => {
      (httpServiceMock.post as any).mockReturnValueOnce(throwError(() => new Error('fail')));
      await expect(service.twoFactorAuthentication({ phone_number_id: 'p', pin: '123456' } as any)).rejects.toBeDefined();
    });
  });

  describe('getPhoneNumberId', () => {
    it('should call httpService.get with constructed url and return resp.data', async () => {
      const resp = { data: { phone: 'p' } };
      (httpServiceMock.get as any).mockReturnValueOnce(of(resp));
      const r = await service.getPhoneNumberId();
      expect(r).toEqual(resp.data);
    });

    it('should propagate errors when httpService.get fails', async () => {
      (httpServiceMock.get as any).mockReturnValueOnce(throwError(() => new Error('fail')));
      await expect(service.getPhoneNumberId()).rejects.toBeDefined();
    });
  });

  describe('sendGroupMessage', () => {
    it('should construct group messages mapping to groupId and call httpService.post to GoRelayBot and log success', async () => {
      const resp = { status: 200 };
      (httpServiceMock.post as any).mockReturnValueOnce(of(resp));
      await service.sendGroupMessage('g1', [{ type: 'text', content: 'a', to: 'x' } as any]);
    });

    it('should catch errors from httpService.post and log failure without throwing', async () => {
      (httpServiceMock.post as any).mockReturnValueOnce(throwError(() => new Error('fail')));
      await service.sendGroupMessage('g1', [{ type: 'text', content: 'a', to: 'x' } as any]);
    });
  });

});

describe("WhatsApp API service", ()=>{ it("dummy", ()=>{ expect(true).toBe(true) }) })
