'use strict';
/* Shared MakeMyTrip-depth marketplace shell for service categories whose
   supplier integrations are not yet live. This is deliberately UI-preview
   inventory: all example cards are labelled and never submit a real booking. */
(function () {
  const CONFIG = {
    buses: {
      title: 'Bus Tickets', kicker: 'Journey by road', description: 'Compare bus types, departure times, boarding points and onboard facilities.',
      searchTitle: 'Find your bus', fields: [
        {id:'from',label:'From',placeholder:'Departure city',required:true},
        {id:'to',label:'To',placeholder:'Destination city',required:true},
        {id:'date',label:'Travel date',type:'date',required:true},
        {id:'travellers',label:'Passengers',type:'number',value:1,min:1,max:9,required:true}
      ],
      filters: [
        ['Bus type',['AC','Non AC','Sleeper','Seater','Volvo']],
        ['Departure time',['Early morning','Morning','Afternoon','Evening','Night']],
        ['Boarding facilities',['Live tracking','Charging point','Water bottle','Blanket','Reading light']],
        ['Seat preference',['Single seat','Upper berth','Lower berth','Women-only seat']],
        ['Cancellation',['Free cancellation','Partial refund','Non-refundable']]
      ],
      sort:['Recommended','Price: low to high','Departure: earliest','Duration: shortest'],
      items:[
        {name:'Premium AC Sleeper',brand:'Illustrative operator A',time:'18:30 – 08:15',duration:'13h 45m',price:1699,tags:['AC','Sleeper','Live tracking','Lower berth','Free cancellation'],meta:'Boarding and dropping points are shown after supplier connection.'},
        {name:'Volvo Multi-Axle Seater',brand:'Illustrative operator B',time:'20:00 – 09:20',duration:'13h 20m',price:1399,tags:['AC','Seater','Charging point','Partial refund'],meta:'Seat map and exact seat availability require a live operator response.'},
        {name:'Non-AC Sleeper',brand:'Illustrative operator C',time:'21:15 – 11:45',duration:'14h 30m',price:999,tags:['Non AC','Sleeper','Upper berth','Non-refundable'],meta:'Example layout card only; not a bookable departure.'}
      ]
    },
    trains: {
      title:'Train Tickets', kicker:'Explore rail journeys', description:'Compare trains by departure, arrival, duration, class and station.',
      searchTitle:'Search trains', fields:[
        {id:'from',label:'From station or city',placeholder:'e.g. Hyderabad',required:true},
        {id:'to',label:'To station or city',placeholder:'e.g. Bengaluru',required:true},
        {id:'date',label:'Journey date',type:'date',required:true},
        {id:'class',label:'Travel class',type:'select',options:['All classes','AC First Class (1A)','AC 2 Tier (2A)','AC 3 Tier (3A)','Sleeper (SL)','Chair Car (CC)','Second Sitting (2S)']},
        {id:'quota',label:'Quota',type:'select',options:['General','Tatkal','Ladies','Senior Citizen']}
      ],
      filters:[['Travel class',['1A','2A','3A','3E','SL','CC','2S']],['Departure time',['Early morning','Morning','Afternoon','Evening','Night']],['Train type',['Express','Superfast','Intercity','Passenger']],['Availability',['Available','RAC','Waitlist']],['Facilities',['Pantry','Catering','Charging point','Accessible coach']]],
      sort:['Recommended','Departure: earliest','Arrival: earliest','Duration: shortest'],
      items:[
        {name:'Intercity Express',brand:'Illustrative train · Example 1',time:'06:15 – 13:40',duration:'7h 25m',price:780,tags:['CC','2S','Intercity','Available','Catering'],meta:'Train number, running days and live berth availability are not connected.'},
        {name:'Superfast Express',brand:'Illustrative train · Example 2',time:'17:10 – 02:20',duration:'9h 10m',price:1240,tags:['2A','3A','Superfast','RAC','Pantry'],meta:'Live seat availability and PNR status need an authorized rail partner.'},
        {name:'Overnight Express',brand:'Illustrative train · Example 3',time:'21:40 – 07:30',duration:'9h 50m',price:640,tags:['SL','3A','Express','Waitlist','Charging point'],meta:'Example layout card only; no ticket can be issued from this preview.'}
      ]
    },
    cabs: {
      title:'Cabs & Transfers', kicker:'Go door to door', description:'Compare airport transfers, local rentals, one-way trips and round trips.',
      searchTitle:'Plan your cab', fields:[
        {id:'trip',label:'Trip type',type:'select',options:['Airport transfer','One way','Round trip','Hourly rental','Outstation']},
        {id:'pickup',label:'Pickup location',placeholder:'Pickup address or airport',required:true},
        {id:'drop',label:'Drop location',placeholder:'Drop address',required:true},
        {id:'date',label:'Pickup date',type:'date',required:true},
        {id:'time',label:'Pickup time',type:'time',required:true},
        {id:'riders',label:'Passengers',type:'number',value:1,min:1,max:12}
      ],
      filters:[['Vehicle type',['Hatchback','Sedan','SUV','Premium','Tempo Traveller']],['Seats',['4 seats','5 seats','6 seats','7+ seats']],['Facilities',['AC','Extra luggage','Child seat','Wheelchair accessible']],['Trip features',['Airport pickup','One way','Round trip','Hourly']],['Cancellation',['Free cancellation','Pay later','Non-refundable']]],
      sort:['Recommended','Price: low to high','Capacity: high to low'],
      items:[
        {name:'Comfort Sedan',brand:'Illustrative fleet category',time:'Pickup as selected',duration:'4 seats · 2 bags',price:1299,tags:['Sedan','4 seats','AC','Airport pickup','Free cancellation'],meta:'Final fare depends on route, tolls, parking, waiting and supplier quote.'},
        {name:'Premium SUV',brand:'Illustrative fleet category',time:'Pickup as selected',duration:'6 seats · 4 bags',price:2199,tags:['SUV','6 seats','AC','Extra luggage','Pay later'],meta:'Vehicle make/model and driver assignment are supplier-confirmed.'},
        {name:'Executive Hatchback',brand:'Illustrative fleet category',time:'Pickup as selected',duration:'4 seats · 1 bag',price:899,tags:['Hatchback','4 seats','AC','One way','Non-refundable'],meta:'Example layout card only; not a confirmed vehicle or fare.'}
      ]
    },
    villas: {
      title:'Villas & Homestays', kicker:'Stay your own way', description:'Discover villas, apartments, resorts and homestays for every kind of stay.',
      searchTitle:'Find your stay', fields:[
        {id:'destination',label:'City, area or property',placeholder:'Where do you want to stay?',required:true},
        {id:'checkin',label:'Check-in',type:'date',required:true},
        {id:'checkout',label:'Check-out',type:'date',required:true},
        {id:'guests',label:'Guests',type:'number',value:2,min:1,max:20}
      ],
      filters:[['Property type',['Villa','Apartment','Resort','Homestay','Farm stay']],['Price per night',['Under ₹2,000','₹2,000–₹4,000','₹4,000–₹7,000','₹7,000–₹12,000','₹12,000+']],['Guest rating',['Excellent 4.5+','Very good 4.0+','Good 3.5+']],['Business essentials',['Wi-Fi','Breakfast included','All meals','Pay at property']],['Room amenities',['Kitchenette','Jacuzzi','Bathtub','Private pool','Fireplace']],['Room views',['Garden view','City view','Sea view','Pool view']],['Booking preferences',['Instant book','Entire property','Great deals']],['House rules',['Self check-in','Pets allowed','Family friendly','Smoking allowed']],['Cancellation',['Free cancellation','Non-refundable']]],
      sort:['Recommended','Price: low to high','Guest rating: highest','Lowest price & best rated'],
      items:[
        {name:'Private Garden Villa',brand:'Illustrative property · Goa',time:'Stay dates as selected',duration:'3 bedrooms · Entire villa',price:7800,tags:['Villa','Excellent 4.5+','Wi-Fi','Private pool','Garden view','Instant book','Free cancellation'],meta:'Property photos, address, rates and availability must come from an authorized accommodation supplier.'},
        {name:'Sea View Apartment',brand:'Illustrative property · Coastal destination',time:'Stay dates as selected',duration:'2 bedrooms · Apartment',price:5400,tags:['Apartment','Very good 4.0+','Wi-Fi','Sea view','Entire property','Free cancellation'],meta:'Room inventory, taxes and house rules require live confirmation.'},
        {name:'Boutique Homestay',brand:'Illustrative property · City centre',time:'Stay dates as selected',duration:'1 bedroom · Homestay',price:2600,tags:['Homestay','Good 3.5+','Breakfast included','City view','Family friendly'],meta:'Example layout card only; no room is held or available through this preview.'}
      ]
    },
    activities: {
      title:'Tours & Attractions', kicker:'Make more of every destination', description:'Discover city tours, guided experiences, attraction tickets and day trips.',
      searchTitle:'Explore experiences', fields:[
        {id:'destination',label:'Destination',placeholder:'City or attraction',required:true},
        {id:'date',label:'Activity date',type:'date',required:true},
        {id:'category',label:'Experience type',type:'select',options:['All experiences','Sightseeing','Adventure','Theme parks','Museums & culture','Food experiences','Day trips']},
        {id:'travellers',label:'Travellers',type:'number',value:2,min:1,max:20}
      ],
      filters:[['Categories',['Sightseeing','Adventure','Theme parks','Museums & culture','Food experiences','Day trips']],['Duration',['Under 2 hours','2–4 hours','Half day','Full day']],['Start time',['Morning','Afternoon','Evening']],['Language',['English','Hindi','Local language']],['Traveller rating',['Excellent 4.5+','Very good 4.0+']],['Cancellation',['Free cancellation','Non-refundable']]],
      sort:['Recommended','Price: low to high','Duration: shortest','Rating: highest'],
      items:[
        {name:'City Highlights Guided Tour',brand:'Illustrative experience · Guided tour',time:'Morning and afternoon slots',duration:'3 hours',price:1199,tags:['Sightseeing','2–4 hours','Morning','English','Excellent 4.5+','Free cancellation'],meta:'Meeting point, guide language, inclusions and ticket validity require supplier confirmation.'},
        {name:'Adventure Day Experience',brand:'Illustrative experience · Outdoor',time:'Morning departure',duration:'Full day',price:2499,tags:['Adventure','Full day','Morning','English','Very good 4.0+'],meta:'Age restrictions, safety requirements and weather policy are activity-specific.'},
        {name:'Culture & Food Walk',brand:'Illustrative experience · Local culture',time:'Evening slot',duration:'2 hours',price:899,tags:['Food experiences','2–4 hours','Evening','Hindi','Free cancellation'],meta:'Example layout card only; no operator or ticket is currently connected.'}
      ]
    },
    visa: {
      title:'Visa Assistance', kicker:'Prepare for your next destination', description:'Understand destination requirements and organise your visa application with travel support.',
      searchTitle:'Check your visa requirements', fields:[
        {id:'destination',label:'Destination country',placeholder:'Select destination country',required:true},
        {id:'nationality',label:'Traveller nationality',placeholder:'e.g. Indian',required:true},
        {id:'residence',label:'Country of residence',placeholder:'Where do you currently live?',required:true},
        {id:'purpose',label:'Travel purpose',type:'select',options:['Tourism','Business','Study','Transit','Work','Visit family']},
        {id:'travel',label:'Expected travel date',type:'date',required:true},
        {id:'applicants',label:'Applicants',type:'number',value:1,min:1,max:20}
      ],
      filters:[['Visa type',['Tourist','Business','Transit','Student','Work']],['Entry type',['Single entry','Double entry','Multiple entry']],['Application support',['Document checklist','Appointment assistance','Application review']],['Processing option',['Standard','Priority where eligible']]],
      sort:['Most relevant','Destination: A–Z'],
      items:[
        {name:'Tourist visa guidance',brand:'Service category · Enquiry based',time:'Requirements depend on nationality and destination',duration:'Eligibility review',price:null,tags:['Tourist','Single entry','Multiple entry','Document checklist'],meta:'No approval, processing time or government fee is guaranteed. Official rules and provider availability must be checked for each applicant.'},
        {name:'Business visa assistance',brand:'Service category · Enquiry based',time:'Requirements depend on travel purpose',duration:'Document review',price:null,tags:['Business','Single entry','Multiple entry','Application review'],meta:'Supporting documents and eligibility vary by destination and applicant.'},
        {name:'Transit visa guidance',brand:'Service category · Enquiry based',time:'Depends on itinerary and airport',duration:'Eligibility review',price:null,tags:['Transit','Single entry','Document checklist'],meta:'Transit requirements must be verified against current official government guidance.'}
      ]
    },
    forex: {
      title:'Forex Card & Currency', kicker:'Get ready to travel globally', description:'Explore foreign currency and travel-card options through authorised providers.',
      searchTitle:'Plan your currency requirement', fields:[
        {id:'city',label:'Your city',placeholder:'Delivery or pickup city',required:true},
        {id:'currency',label:'Currency',type:'select',options:['USD · US Dollar','EUR · Euro','GBP · Pound Sterling','AED · UAE Dirham','SGD · Singapore Dollar','AUD · Australian Dollar','CAD · Canadian Dollar','THB · Thai Baht']},
        {id:'amount',label:'Amount required',type:'number',placeholder:'Enter amount',min:1,required:true},
        {id:'date',label:'Travel date',type:'date'}
      ],
      filters:[['Product type',['Forex card','Currency notes','Multi-currency card']],['Delivery option',['Home delivery','Branch pickup']],['Card features',['Contactless','Online payments','ATM withdrawals','Reloadable']],['Provider checks',['KYC required','Eligibility review']]],
      sort:['Recommended','Product type: A–Z'],
      items:[
        {name:'Multi-currency travel card',brand:'Product category · Provider quote required',time:'Provider availability varies by city',duration:'Secure provider handoff',price:null,tags:['Forex card','Multi-currency card','Contactless','Online payments','Reloadable','KYC required'],meta:'Rates, fees, KYC, issuance and delivery are confirmed only by an authorised forex provider. Do not store card credentials in this site.'},
        {name:'Foreign currency notes',brand:'Product category · Provider quote required',time:'Pickup or delivery subject to provider',duration:'Provider fulfilment',price:null,tags:['Currency notes','Branch pickup','Home delivery','KYC required'],meta:'The displayed currency list is a search aid, not an executable exchange quote.'},
        {name:'Single-currency travel card',brand:'Product category · Provider quote required',time:'Provider availability varies',duration:'Secure provider handoff',price:null,tags:['Forex card','ATM withdrawals','Online payments','KYC required'],meta:'Availability, fees and terms require provider confirmation.'}
      ]
    },
    insurance: {
      title:'Travel Insurance', kicker:'Travel with more confidence', description:'Review travel protection categories and compare policy terms through an authorised insurer.',
      searchTitle:'Find suitable travel cover', fields:[
        {id:'destination',label:'Destination',placeholder:'Country or region',required:true},
        {id:'residence',label:'Country of residence',placeholder:'Country',required:true},
        {id:'start',label:'Trip start date',type:'date',required:true},
        {id:'end',label:'Trip end date',type:'date',required:true},
        {id:'ages',label:'Traveller ages',placeholder:'e.g. 32, 29',required:true},
        {id:'trip',label:'Trip type',type:'select',options:['Single trip','Annual multi-trip','Student travel','Family travel']}
      ],
      filters:[['Plan type',['Single trip','Annual multi-trip','Family','Student']],['Coverage areas',['Medical expenses','Baggage loss','Trip delay','Trip cancellation','Emergency assistance']],['Deductible',['No deductible','Low deductible','Standard deductible']],['Policy options',['Worldwide','Schengen compliant','Domestic']]],
      sort:['Recommended','Coverage: highest','Premium: lowest'],
      items:[
        {name:'Single-trip protection',brand:'Policy category · Insurer quote required',time:'Cover dates as selected',duration:'One insured trip',price:null,tags:['Single trip','Medical expenses','Baggage loss','Trip delay','Emergency assistance'],meta:'Premium, exclusions, limits and eligibility must be returned by an authorised insurer before purchase.'},
        {name:'Annual multi-trip protection',brand:'Policy category · Insurer quote required',time:'Annual policy period',duration:'Multiple eligible trips',price:null,tags:['Annual multi-trip','Medical expenses','Trip cancellation','Worldwide'],meta:'Trip duration caps, age limits and exclusions are policy-specific.'},
        {name:'Family travel protection',brand:'Policy category · Insurer quote required',time:'Cover dates as selected',duration:'Eligible family travellers',price:null,tags:['Family','Medical expenses','Baggage loss','Emergency assistance'],meta:'Covered family members and benefits must be confirmed in the policy wording.'}
      ]
    }
  };

  const $ = (id, root=document) => root.querySelector(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = value => value == null ? 'Provider quote' : '₹' + Number(value).toLocaleString('en-IN');
  function fieldHtml(f) {
    const id = `mkt-${f.id}`;
    if (f.type === 'select') return `<label class="mkt-field"><span>${esc(f.label)}</span><select name="${esc(f.id)}" id="${id}">${(f.options || []).map(o=>`<option>${esc(o)}</option>`).join('')}</select></label>`;
    const type = f.type || 'text';
    return `<label class="mkt-field"><span>${esc(f.label)}</span><input id="${id}" name="${esc(f.id)}" type="${type}" placeholder="${esc(f.placeholder || '')}" ${f.value != null ? `value="${esc(f.value)}"` : ''} ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''} ${f.required ? 'required' : ''}></label>`;
  }
  function mount() {
    const key = document.body.dataset.marketplaceService;
    const cfg = CONFIG[key];
    const root = $('#mktRoot');
    if (!cfg || !root) return;
    root.innerHTML = `
      <section class="mkt-hero"><div class="mkt-hero__inner"><p class="mkt-kicker">${esc(cfg.kicker)}</p><h1>${esc(cfg.title)}</h1><p>${esc(cfg.description)}</p></div></section>
      <div class="mkt-wrap" id="mktMain">
        <section class="mkt-search-card" aria-labelledby="mktSearchTitle"><div class="mkt-search-head"><div><p class="mkt-eyebrow">JACKPOTS WORLD · TRAVEL MARKETPLACE</p><h2 id="mktSearchTitle">${esc(cfg.searchTitle)}</h2></div><span class="mkt-step-tag">Search · Compare · Plan</span></div>
          <form id="mktSearchForm" class="mkt-search-grid">${cfg.fields.map(fieldHtml).join('')}<button class="mkt-search-btn" type="submit">Search</button></form>
        </section>
        <div class="mkt-preview-alert" role="note"><span class="mkt-alert-mark">i</span><div><strong>Supplier integration preview</strong><p>These layouts and example options are for interface development only. They are not live inventory, live prices or confirmed availability. A real quote or booking will only appear after an authorised supplier integration is connected.</p></div></div>
        <div class="mkt-toolbar"><div><p class="mkt-eyebrow">YOUR SEARCH</p><h2 id="mktResultTitle">Explore ${esc(cfg.title.toLowerCase())}</h2><p id="mktResultMeta" class="mkt-muted">Enter your journey details to preview the search experience.</p></div><label class="mkt-sort">Sort by <select id="mktSort">${cfg.sort.map((s,i)=>`<option value="${i}">${esc(s)}</option>`).join('')}</select></label></div>
        <div class="mkt-layout"><aside class="mkt-filters" aria-label="Search filters"><div class="mkt-filter-head"><h3>Filters</h3><button type="button" id="mktClear">Clear all</button></div><label class="mkt-filter-search"><span>Search options</span><input id="mktFilterSearch" type="search" placeholder="Find a filter option"></label><div id="mktFilterGroups"></div></aside>
          <section class="mkt-results" id="mktResults" aria-live="polite"><div class="mkt-result-tools"><span id="mktCount"></span><label>Search results <input id="mktCardSearch" type="search" placeholder="Search options"></label></div><div id="mktCards" class="mkt-cards"></div></section>
        </div>
        <section class="mkt-steps"><p class="mkt-eyebrow">YOUR JOURNEY</p><h2>Every step of your journey, in one place</h2><div class="mkt-step-grid"><article><b>01</b><h3>Search</h3><p>Enter destinations, dates and traveller details.</p></article><article><b>02</b><h3>Compare</h3><p>Sort options and use detailed filters to narrow your choices.</p></article><article><b>03</b><h3>Details</h3><p>Review facilities, inclusions, restrictions and supplier conditions.</p></article><article><b>04</b><h3>Traveller details</h3><p>Provide the passenger, guest or applicant information required by the service.</p></article><article><b>05</b><h3>Review & payment</h3><p>Confirm the supplier quote, taxes, cancellation terms and payment route.</p></article><article><b>06</b><h3>My Trips</h3><p>Find confirmations, tickets, application updates and support in your account when the integration is live.</p></article></div></section>
      </div>
      <dialog class="mkt-dialog" id="mktDialog"><form method="dialog"><button class="mkt-dialog-close" aria-label="Close">×</button></form><div id="mktDialogBody"></div></dialog>`;
    let selected = new Map();
    let submitted = false;
    let searchValues = {};
    let cardQuery = '';
    let filterQuery = '';
    let sortIndex = 0;
    const cardsHost = $('#mktCards');
    const filterHost = $('#mktFilterGroups');

    function durationMinutes(value) {
      const m = /(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i.exec(String(value || ''));
      return m && (m[1] || m[2]) ? Number(m[1] || 0) * 60 + Number(m[2] || 0) : Infinity;
    }
    function startMinutes(value) {
      const m = /(?:^|\s)(\d{1,2}):(\d{2})/.exec(String(value || ''));
      return m ? Number(m[1]) * 60 + Number(m[2]) : Infinity;
    }
    function filteredRows() {
      let rows = cfg.items.filter(item => {
        const hay = [item.name,item.brand,item.meta,...item.tags].join(' ').toLowerCase();
        return !cardQuery || hay.includes(cardQuery);
      });
      rows = rows.filter(item => cfg.filters.every(([group]) => {
        const set = selected.get(group);
        return !set || !set.size || item.tags.some(t => set.has(t));
      }));
      const sortName = cfg.sort[sortIndex] || '';
      if (/Price: low/.test(sortName)) rows.sort((a,b)=>(a.price ?? Infinity)-(b.price ?? Infinity));
      else if (/Departure: earliest/.test(sortName)) rows.sort((a,b)=>startMinutes(a.time)-startMinutes(b.time));
      else if (/Duration: shortest/.test(sortName)) rows.sort((a,b)=>durationMinutes(a.duration)-durationMinutes(b.duration));
      else if (/Rating: highest|Guest rating/.test(sortName)) rows.sort((a,b)=>String(b.tags).localeCompare(String(a.tags)));
      return rows;
    }
    function renderFilters() {
      filterHost.innerHTML = cfg.filters.map(([group, options]) => {
        const shown = options.filter(o => !filterQuery || (group+' '+o).toLowerCase().includes(filterQuery));
        const active = selected.get(group) || new Set();
        return `<section class="mkt-filter-group"><h3>${esc(group)}</h3>${shown.map(o=>`<label class="mkt-filter-option"><input type="checkbox" data-mkt-filter="${esc(group)}" value="${esc(o)}" ${active.has(o)?'checked':''}><span>${esc(o)}</span></label>`).join('') || '<p class="mkt-muted">No matching options</p>'}</section>`;
      }).join('');
    }
    function cardHtml(item, index) {
      const safeName = esc(item.name);
      const tags = item.tags.slice(0,5).map(t=>`<span class="mkt-tag">${esc(t)}</span>`).join('');
      const price = item.price == null ? '<strong>Quote required</strong>' : `<strong>${money(item.price)}</strong><small>illustrative preview</small>`;
      return `<article class="mkt-card"><div class="mkt-card-art mkt-art-${esc(key)}"><span class="mkt-art-overline">JACKPOTS WORLD</span><span class="mkt-art-title">${safeName}</span><span class="mkt-demo-stamp">PREVIEW</span></div><div class="mkt-card-content"><div class="mkt-card-top"><div><p class="mkt-card-brand">${esc(item.brand)}</p><h3>${safeName}</h3><p class="mkt-card-sub">${esc(item.time)} · ${esc(item.duration)}</p></div><div class="mkt-card-price">${price}</div></div><div class="mkt-tags">${tags}</div><p class="mkt-card-meta">${esc(item.meta)}</p><div class="mkt-card-actions"><button type="button" class="mkt-btn mkt-btn-ghost" data-mkt-detail="${index}">View details</button><a class="mkt-btn mkt-btn-primary" href="/contact-us?service=${encodeURIComponent(key)}&item=${encodeURIComponent(item.name)}">Request live availability</a></div></div></article>`;
    }
    function render() {
      const rows = filteredRows();
      $('#mktCount').textContent = `${rows.length} preview option${rows.length===1?'':'s'} · not live inventory`;
      cardsHost.innerHTML = rows.length ? rows.map((r,i)=>cardHtml(r,cfg.items.indexOf(r))).join('') : `<div class="mkt-empty"><h3>No options match these filters</h3><p>Remove one or more filters and search again.</p><button class="mkt-btn mkt-btn-ghost" id="mktReset">Clear filters</button></div>`;
    }
    $('#mktSearchForm').addEventListener('submit', e => {
      e.preventDefault();
      const data = new FormData(e.currentTarget);
      searchValues = Object.fromEntries(data.entries());
      submitted = true;
      $('#mktResultTitle').textContent = `${cfg.title} · ${searchValues.from || searchValues.pickup || searchValues.destination || searchValues.city || 'Your search'}`;
      $('#mktResultMeta').textContent = Object.entries(searchValues).filter(([,v])=>String(v).trim()).map(([k,v])=>`${k.replace(/([A-Z])/g,' $1')}: ${v}`).join(' · ');
      render();
      $('#mktResults')?.scrollIntoView({behavior:'smooth',block:'start'});
    });
    filterHost.addEventListener('change', e => {
      const input = e.target.closest('[data-mkt-filter]'); if (!input) return;
      const group = input.dataset.mktFilter; const set = selected.get(group) || new Set();
      if (input.checked) set.add(input.value); else set.delete(input.value);
      if (set.size) selected.set(group,set); else selected.delete(group);
      render();
    });
    $('#mktFilterSearch').addEventListener('input', e => { filterQuery = e.target.value.toLowerCase(); renderFilters(); });
    $('#mktCardSearch').addEventListener('input', e => { cardQuery = e.target.value.toLowerCase(); render(); });
    $('#mktSort').addEventListener('change', e => { sortIndex = Number(e.target.value); render(); });
    $('#mktClear').addEventListener('click', () => { selected.clear(); $('#mktFilterSearch').value=''; filterQuery=''; renderFilters(); render(); });
    cardsHost.addEventListener('click', e => { if (e.target.id === 'mktReset') { selected.clear(); renderFilters(); render(); } });
    cardsHost.addEventListener('click', e => {
      const btn = e.target.closest('[data-mkt-detail]'); if (!btn) return;
      const item = cfg.items[Number(btn.dataset.mktDetail)];
      $('#mktDialogBody').innerHTML = `<p class="mkt-eyebrow">PREVIEW DETAILS</p><h2>${esc(item.name)}</h2><p>${esc(item.brand)}</p><p>${esc(item.meta)}</p><div class="mkt-tags">${item.tags.map(t=>`<span class="mkt-tag">${esc(t)}</span>`).join('')}</div><p class="mkt-dialog-warning">This is illustrative interface data. Supplier availability, policy and final price have not been verified.</p><a class="mkt-btn mkt-btn-primary" href="/contact-us?service=${encodeURIComponent(key)}&item=${encodeURIComponent(item.name)}">Talk to our travel team</a>`;
      $('#mktDialog').showModal();
    });
    renderFilters();
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once:true }); else mount();
})();
