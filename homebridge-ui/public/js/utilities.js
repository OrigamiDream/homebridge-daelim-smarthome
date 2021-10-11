function loadJSON(url) {
    return fetch(url).then(response => response.json());
}

function doTransition(elementFrom, elementTo) {
    const mainElement = document.getElementById("main");
    mainElement.classList.add("transiting");
    elementFrom.classList.add('transition-from');
    setTimeout(() => {
        if(!elementFrom.classList.contains("hidden")) {
            elementFrom.classList.add("hidden");
        }
        if(elementTo.classList.contains('hidden')) {
            elementTo.classList.remove('hidden');
        }
        elementTo.classList.add("start-fade-out");
        setTimeout(() => {
            elementTo.classList.remove('start-fade-out');
            elementTo.classList.remove('hidden');
            elementFrom.classList.remove('transition-from');
            mainElement.classList.remove('transiting');
        }, 500); // after 500ms again
    }, 500); // after 500ms
}

function createElement(tagName, options) {
    options = options || {};

    const element = document.createElement(tagName);
    for(const key of Object.keys(options)) {
        element[key] = options[key];
    }
    return element;
}