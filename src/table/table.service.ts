import { Injectable } from '@nestjs/common';

@Injectable()
export class TableService {

    private readonly url: string;

    constructor() {
        const posBackendUrl = process.env.ENVIRONMENT === 'homologation' ? process.env.POS_HOM_BACKEND_URL : process.env.ENVIRONMENT === 'production' ? process.env.POS_PROD_BACKEND_URL : process.env.POS_DEV_BACKEND_URL;
        this.url = posBackendUrl;
    }

    async orderTable(id: number): Promise<any> {

        const response = await fetch(`${this.url}/tables/${id}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
        });


        if (!response.ok) {
            throw new Error('Failed to order table');
        }

        return await response.json();
    }

    async startPayment(id: number): Promise<any> {

        const response = await fetch(`${this.url}/tables/${id}/payment`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            throw new Error('Failed to start payment');
        }

        return await response.json();
    }

    async finishPayment(id: number): Promise<any> {

        const response = await fetch(`${this.url}/tables/${id}/close`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            throw new Error('Failed to finish payment');
        }

        return await response.json();
    }

    async orderMessage(id: number): Promise<any> {

        const response = await fetch(`${this.url}/tables/${id}/message`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
        });


        if (!response.ok) {
            throw new Error('Failed to order table');
        }

        return await response.json();
    }

}
