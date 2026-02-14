import subprocess


def run_simple_command(command, **kwargs):
    print('CMD: {}'.format(command))
    out = subprocess.run(command.format(**kwargs), shell=True, capture_output=True, text=True)
    return str(out.stdout).strip()


def main():
    filename = run_simple_command("npm pack")
    filename = filename.split("\n")[-1]
    run_simple_command(f"mv {filename} ./.homebridge")
    run_simple_command(f"docker exec -it homebridge npm install /homebridge/{filename}")


if __name__ == '__main__':
    main()
