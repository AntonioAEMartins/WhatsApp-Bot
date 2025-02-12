import { Injectable, NestMiddleware, ForbiddenException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class AllowedIpsMiddleware implements NestMiddleware {
    // Defina os IPs autorizados:
    // Inclua o localhost e os IPs autorizados do iPag
    private readonly allowedIps: string[] = [
        '127.0.0.1',
        '::1',
        '52.73.203.226',
        '184.73.165.27'
    ];

    use(req: Request, res: Response, next: NextFunction) {
        // Extraia o IP da requisição
        // Se estiver por trás de um proxy ou load balancer, pode ser necessário verificar o header 'x-forwarded-for'
        const forwardedFor = req.headers['x-forwarded-for'];
        let ip: string;

        if (typeof forwardedFor === 'string') {
            // Caso o header contenha uma lista (por exemplo, "ip1, ip2"), pegue o primeiro
            ip = forwardedFor.split(',')[0].trim();
        } else {
            // Tente obter o IP a partir do socket
            ip = req.socket?.remoteAddress || '';
        }

        console.log('[AllowedIpsMiddleware] ip', ip);
        // Verifica se o IP extraído está na lista de permitidos ou se é um IP 172.x.x.x
        if (!this.allowedIps.includes(ip) && !ip.startsWith('172.')) {
            // Caso não esteja, bloqueia a requisição
            throw new ForbiddenException('Access denied');
        }

        next();
    } 
}
