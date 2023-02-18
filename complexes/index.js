const axios = require('axios');
const fs = require('fs');

class FetcherBase {
    constructor(filename, regex) {
        this.filename = filename;
        this.targetDirectory = './complexes';
        this.baseURL = 'https://smarthome.daelimcorp.co.kr/main/choice_1.do'
        this.regex = regex
        this.pipes = [];

        this.addPipe(async () => {
            const response = await axios({
                url: this.baseURL,
                method: 'get'
            }).catch(reason => {
                console.error(reason);
                return undefined;
            });
            if(response === undefined) {
                console.error('Failed to parse from complex server');
                process.exit(1);
                return undefined;
            }
            return response.data;
        });
        this.addPipe(async (response) => {
            return response.split('\n').map(str => str.trim()).join('\n');
        })
        this.addPipe(async (response) => {
            return response.match(this.regex) || [];
        });
    }

    async doChain() {
        let result = undefined;
        for(let i = 0; i < this.pipes.length; i++) {
            const pipe = this.pipes[i];
            if(i === 0) {
                result = await pipe.fn(...pipe.args);
            } else {
                result = await pipe.fn(result, ...pipe.args);
            }
        }
        return result;
    }

    addPipe(fn) {
        this.pipes.push({
            fn: fn,
            args: Array.prototype.slice.call(arguments, 1)
        });
    }

    async streamOutput(json) {
        const data = JSON.stringify(json, null, 4);
        try {
            fs.writeFileSync(`${this.targetDirectory}/${this.filename}`, data);
            console.log('Done.');
        } catch(e) {
            console.error(e);
        }
    }

}

class RegionFetcher extends FetcherBase {

    constructor() {
        super('regions.json', /{area( |\n|):( |\n|)"(.*)"( |\n|),( |\n|)citys( |\n|):( |\n|)\[(.*)]}/gi);

        // Parse strings into JSONs
        this.addPipe(async (groups) => {
            let json = [];
            for(const group of groups) {
                json.push(JSON.parse(group.replace('area', '"area"').replace('citys', '"cities"')));
            }
            return json;
        });
        // Flatten JSONs
        this.addPipe(async (json) => {
            let cities = [];
            for(const region of json) {
                cities.push(...region['cities']);
            }
            return cities;
        });
        // Forming
        this.addPipe(async (cities) => {
            return {
                'regions': cities
            }
        });
        this.addPipe(this.streamOutput.bind(this));
    }
}

class ComplexFetcher extends FetcherBase {

    constructor() {
        super('complexes.json', /region\.push\({(.*( |\n|))+?}\)/gi);

        // Parse strings into JSONs
        this.addPipe(async (groups) => {
            let complexes = [];
            for(const raw of groups) {
                let str = raw.substring('region.push('.length);
                str = str.substring(0, str.length - ')'.length);
                str = str.split('\n').map(line => {
                    if(line.indexOf(':') !== -1) {
                        const split = line.split(':');
                        const key = split[0].trim();
                        return `"${key}":${split[1]}`
                    } else {
                        return line;
                    }
                }).join('\n');
                complexes.push(JSON.parse(str));
            }
            return complexes;
        });
        // Filter out
        this.addPipe(async (complexes) => {
            let filtered = [];
            for(const complex of complexes) {
                filtered.push({
                    index: complex['index'],
                    apartId: complex['apartId'],
                    region: complex['danjiArea'],
                    name: complex['name'],
                    status: complex['status'],
                    serverIp: complex['ip'],
                    directoryName: complex['danjiDirectoryName'],
                    geolocation: {
                        state: complex['dongStep1'],
                        city: complex['dongStep2'],
                        details: complex['dongStep3']
                    }
                });
            }
            return filtered;
        })
        // Organize
        this.addPipe(async (complexes) => {
            let used = [];
            let organized = [];
            for(const complex of complexes) {
                const region = complex.region;
                if(used.indexOf(region) === -1) {
                    used.push(region);
                    organized.push({
                        region: region,
                        complexes: []
                    });
                }
                const target = organized.filter(o => o.region === region);
                if(target.length > 0) {
                    target[0].complexes.push({ ...complex });
                }
            }
            return organized;
        });
        // Forming
        this.addPipe(async (complexes) => {
            return {
                'complexes': complexes
            };
        });
        this.addPipe(this.streamOutput.bind(this));
    }

}

const fetchers = [
    new RegionFetcher(),
    new ComplexFetcher()
];

(async () => {
    for(let fetcher of fetchers) {
        await fetcher.doChain();
    }
})();