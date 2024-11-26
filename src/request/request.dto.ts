// src/common/dto/base-response.dto.ts
export class BaseResponseDto<T> {
    msg: string;
    data: T;
    count?: number;
}

export class ListResponseDto<T> extends BaseResponseDto<T[]> {
    count: number;
}

export class SimpleResponseDto<T> extends BaseResponseDto<T> {}