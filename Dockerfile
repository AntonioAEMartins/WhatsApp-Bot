# Use a imagem oficial do Redis como base
FROM redis:latest

# Defina o diretório de trabalho
WORKDIR /data

# Copie arquivos de configuração personalizados (se necessário)
# ADD redis.conf /usr/local/etc/redis/redis.conf

# Exponha a porta padrão do Redis
EXPOSE 6379

# Comando para iniciar o Redis (com ou sem configuração personalizada)
CMD ["redis-server"]
# Se estiver usando um arquivo de configuração personalizado, use:
# CMD ["redis-server", "/usr/local/etc/redis/redis.conf"]
