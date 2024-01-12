#!/bin/sh

wd=$(pwd)
if [[ $wd == *scripts ]]
then
  wd="$(pwd)/.."
fi

root_dir="$(pwd)/.homebridge"
echo "Working for directory: $root_dir"

if [[ -d $root_dir ]]
then
  echo "Cleaning up the Docker and its volume..."
  docker stop homebridge -t 1
  docker rm homebridge
  rm -rf $root_dir
fi

echo "Building npm distribution..."
npm run --silent build

echo "Packing the distribution up..."
deployment=$(npm --silent pack)

echo "Deploying the distribution file..."
mkdir -p "$root_dir"
mv "$(pwd)/$deployment" "$root_dir"

echo "Committing Homebridge Docker container..."
docker run \
  -e TZ=Asia/Seoul \
  -e HOMEBRIDGE_CONFIG_UI=1 \
  -e HOMEBRIDGE_CONFIG_UI_PORT=8581 \
  --restart always \
  --name=homebridge \
  -p 8581:8581/tcp \
  -v $root_dir:/homebridge \
  -d \
  homebridge/homebridge:latest

echo "Waiting for the Docker container up..."
until [ "`docker inspect -f {{.State.Running}} homebridge`" == "true" ]; do
  sleep 0.1
done

echo "Installing the plugin remotely..."
docker exec -i homebridge npm install --silent "/homebridge/$deployment"

echo "All jobs have finished"