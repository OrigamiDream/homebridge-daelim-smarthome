import subprocess
import os


def get_default_environmental_variable(key, fn):
    if key in os.environ:
        return os.environ[key]
    else:
        return fn()


def run_simple_command(command, **kwargs):
    print('CMD: {}'.format(command))
    out = subprocess.run(command.format(**kwargs), shell=True, capture_output=True, text=True)
    return str(out.stdout).strip()


def build_ssh_address(username, ip_address):
    return '{}@{}'.format(username, ip_address)


def main():
    username = get_default_environmental_variable('HOMEBRIDGE_PI_USERNAME', lambda: input('Enter username: '))
    ip_address = get_default_environmental_variable('HOMEBRIDGE_PI_IP_ADDRESS', lambda: input('Enter ip address: '))
    port = get_default_environmental_variable('HOMEBRIDGE_PI_PORT', 22)
    pem_file = get_default_environmental_variable('HOMEBRIDGE_PI_SSH_PEM', lambda: input('Enter PEM file path: '))
    pem_file = pem_file.replace(' ', '\\ ')

    address = build_ssh_address(username, ip_address)

    filename = run_simple_command('npm pack')
    run_simple_command('scp -i {} -P {} {} {}:~/{}'
                       .format('{pem}', port, filename, address, filename), pem=pem_file)

    docker_cmd = 'sudo mv ~/{} ~/homebridge/{}'.format(filename, filename)
    run_simple_command('ssh -i {} -p {} {} "{}"'
                       .format('{pem}', port, address, docker_cmd), pem=pem_file)

    docker_cmd = 'docker exec -i homebridge npm install {}'.format(filename)
    run_simple_command('ssh -i {} -p {} {} "{}"'.format('{pem}', port, address, docker_cmd), pem=pem_file)
    run_simple_command('ssh -i {} -p {} {} "{}"'.format('{pem}', port, address, 'sudo rm ~/homebridge/{}'.format(filename)), pem=pem_file)
    run_simple_command('rm {}'.format(filename))
    pass


if __name__ == '__main__':
    main()
